import type {
  Context,
  AvailableCommand,
  AcpContentBlock,
  McpServer,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionNotification,
  SessionModeState,
  StopReason,
  Agent,
  AgentHandle,
  AgentOptions,
  UserMessage,
  Session,
  SessionEvent,
  SessionId,
  TurnEndReason,
} from "./host.js";
import { dshRuntime } from "./dshRuntime.js";
/** One standard ACP session's Agent, configuration, prompt, update, and teardown lifecycle. */

import { AcpContentError, admitAcpPrompt } from "./content.ts";
import { turnEndToStopReason } from "./codec.ts";
import { mountAcpMcpServers } from "./mcp.ts";
import { AcpModelControl } from "./model-control.ts";
import { assistantUpdates, SessionActivityUpdates } from "./updates.ts";

/** Inputs shared by fresh and resumed ACP session construction. */
interface AcpSessionBuildOptions {
  cwd: string;
  mcpServers: readonly McpServer[];
  agentOptions: AgentOptions;
  signal: AbortSignal;
  notify: (notification: SessionNotification) => Promise<void>;
}

/** Fresh ACP session construction inputs. */
export interface CreateAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId;
}

/** Persisted ACP session construction inputs. */
export interface ResumeAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId;
}

interface InflightPrompt {
  resolve: (reason: StopReason) => void;
  reject: (error: Error) => void;
  messageId: string | undefined;
  messageQueued: boolean;
  turn: number | undefined;
  endReason: TurnEndReason | undefined;
  admissionDone: Promise<void>;
  finishAdmission: () => void;
  admissionController: AbortController;
  cancellationDone: PromiseWithResolvers<void>;
  cancelStartedIdle: boolean;
  settlementStarted: boolean;
  outputError: Error | undefined;
  agentError: Error | undefined;
}

/** Standard invalid-parameter failure with protocol-safe detail. */
function invalidParams(detail: string): Error {
  return dshRuntime().sdk.RequestError.invalidParams(undefined, detail);
}

/** Standard internal failure with protocol-safe detail. */
function internalError(detail: string): Error {
  return dshRuntime().sdk.RequestError.internalError(undefined, detail);
}

async function composeAgent(ctx: Context, options: AcpSessionBuildOptions) {
  dshRuntime().agent.installModelSelection(ctx);
  await mountAcpMcpServers(ctx, options.mcpServers, options.cwd);
}

/** Per-session ACP module. */
export class AcpSession {
  /** The exact top-level Agent owned by this ACP session. */
  readonly agent: Agent;
  private readonly modelControl: AcpModelControl;
  private readonly activityUpdates: SessionActivityUpdates;
  private lastModeId: string | undefined;
  private outputTail = Promise.resolve();
  private advertisedSkills = new Set<string>();
  private inflight: InflightPrompt | undefined;
  private closing: Promise<void> | undefined;

  private constructor(
    private readonly ctx: Context,
    handle: AgentHandle,
    cwd: string,
    private readonly notify: (notification: SessionNotification) => Promise<void>,
  ) {
    this.agent = handle.agent;
    this.activityUpdates = new SessionActivityUpdates(
      ctx,
      this.agent,
      this.agent.session.header.cwd ?? cwd,
    );
    this.modelControl = new AcpModelControl(ctx.llm, handle.agent.model);
    this.disposeAgent = () => handle.dispose();
  }

  private readonly disposeAgent: () => Promise<void>;

  /** Compose a fresh Agent and all requested MCP clients before publication. */
  static async create(ctx: Context, options: CreateAcpSessionOptions): Promise<AcpSession> {
    const fs = ctx.get("fs");
    let cwd = options.cwd;
    if (typeof fs?.resolve === "function" && typeof fs.processPath === "function") {
      cwd = fs.processPath(await fs.resolve(cwd, { signal: options.signal }));
    } else ctx.logger.warn("acp: fs path resolution unavailable, using requested cwd");
    const handle = await ctx.agents.create({
      sessionId: options.sessionId,
      meta: { cwd },
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: (agentCtx) => composeAgent(agentCtx, options),
    });
    return new AcpSession(ctx, handle, options.cwd, options.notify);
  }

  /** Restore a persisted Agent and compose the request's fresh MCP connections. */
  static async resume(ctx: Context, options: ResumeAcpSessionOptions): Promise<AcpSession> {
    const handle = await ctx.agents.resume({
      resumeSessionId: options.sessionId,
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: (agentCtx) => composeAgent(agentCtx, options),
    });
    return new AcpSession(ctx, handle, options.cwd, options.notify);
  }

  /** Whether this module owns an exact Agent reference. */
  owns(agent: Agent): boolean {
    return this.agent === agent;
  }

  /** Whether this module owns an exact Session reference. */
  ownsSession(session: Session): boolean {
    return this.agent.session === session;
  }

  /** Return the complete standard model configuration state. */
  configOptions(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive();
    return this.modelControl.options(signal);
  }

  modes(): SessionModeState | undefined {
    const presets = this.ctx.get("permissionPresets");
    if (!presets) return undefined;
    // ACP v1 SessionModeState has no membership constraint. A derived "custom"
    // stays visible as current without becoming a selectable permission grant.
    this.lastModeId = presets.current(this.agent.session);
    return {
      currentModeId: this.lastModeId,
      availableModes: presets.names.map((id) => {
        const { name, description } = presets.optionOf(id);
        return { id, name, ...(description === undefined ? {} : { description }) };
      }),
    };
  }

  async setMode(modeId: string): Promise<void> {
    this.assertActive();
    const presets = this.ctx.get("permissionPresets");
    if (!presets || modeId === "custom" || !presets.names.includes(modeId)) {
      throw invalidParams(`unavailable permission preset: ${modeId}`);
    }
    try {
      presets.set(this.agent.session, modeId);
    } catch (error) {
      throw invalidParams(
        `cannot select permission preset ${modeId}: ${dshRuntime().llm.errorChain(error)}`,
      );
    }
    this.publishModeChange();
    await this.outputTail;
  }

  private publishModeChange(): void {
    if (this.closing || this.lastModeId === undefined) return;
    const currentModeId = this.ctx.get("permissionPresets")?.current(this.agent.session);
    if (currentModeId === undefined || currentModeId === this.lastModeId) return;
    this.lastModeId = currentModeId;
    this.outputTail = this.outputTail.then(() =>
      this.notify({
        sessionId: this.agent.session.id,
        update: { sessionUpdate: "current_mode_update", currentModeId },
      }),
    );
  }

  /** Apply one standard configuration option to later ACP turns. */
  setConfig(
    configId: string,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<SessionConfigOption[]> {
    this.assertActive();
    return this.modelControl.set(configId, value, signal);
  }

  /** Resolve topology state off-chain, then serialize its notification without blocking execution updates. */
  topologyChanged(): void {
    if (this.closing !== undefined) return;
    void this.modelControl
      .options()
      .then((configOptions) => {
        if (this.closing !== undefined) return;
        const previous = this.outputTail;
        this.outputTail = previous
          .then(() =>
            this.notify({
              sessionId: this.agent.session.id,
              update: { sessionUpdate: "config_option_update", configOptions },
            }),
          )
          .catch((error: unknown) => {
            this.ctx.logger.warn(
              `acp: config-option update failed: ${dshRuntime().llm.errorChain(error)}`,
            );
          });
      })
      .catch((error: unknown) => {
        this.ctx.logger.warn(
          `acp: config-option update failed: ${dshRuntime().llm.errorChain(error)}`,
        );
      });
  }

  advertiseCommands(signal?: AbortSignal): Promise<void> {
    this.outputTail = this.outputTail
      .then(async () => {
        if (this.closing) return;
        const commands = this.ctx.get("commands");
        const skills = this.ctx.get("skills");
        if (!commands || !skills) {
          this.advertisedSkills.clear();
          this.ctx.logger.warn(
            `acp: ${!commands ? "commands" : "skills"} registry unavailable, skipping advertisement`,
          );
          return;
        }
        const cwd = this.agent.session.header.cwd;
        const summaries = await skills.list({
          scope: this.agent,
          ...(cwd && { cwd }),
          ...(signal && { signal }),
        });
        const entries = new Map<string, AvailableCommand>();
        for (const { name, description, input } of commands.list(this.agent)) {
          entries.set(name, { name, description, ...(input && { input: { hint: input.hint } }) });
        }
        for (const { name, description } of summaries) {
          entries.set(`$${name}`, { name: `$${name}`, description });
        }
        if (!this.closing && !signal?.aborted) {
          this.advertisedSkills = new Set(summaries.map((skill) => skill.name));
          await this.notify({
            sessionId: this.agent.session.id,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [...entries.values()].sort((a, b) =>
                a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
              ),
            },
          });
        }
      })
      .catch((error: unknown) => {
        this.ctx.logger.warn(
          `acp: command advertisement failed: ${dshRuntime().llm.errorChain(error)}`,
        );
      });
    return this.outputTail;
  }

  private async executeCommand(prompt: AcpContentBlock[], signal: AbortSignal): Promise<boolean> {
    const line = prompt.find((block) => block.type === "text")?.text;
    if (!line?.startsWith("/")) return false;
    const commands = this.ctx.get("commands");
    if (!commands) return false;
    try {
      const execution = await commands.execute(this.agent, line, [], signal);
      if (!execution) return false;
      // A command can commit an entire compaction outside a model turn.
      // Deliver its queued lifecycle before acknowledging the command.
      await this.outputTail;
      signal.throwIfAborted();
      if (execution.result.text)
        await this.notify({
          sessionId: this.agent.session.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: execution.commandId,
            content: { type: "text", text: execution.result.text },
          },
        });
      return true;
    } catch (error) {
      throw internalError(`command execution failed: ${dshRuntime().llm.errorChain(error)}`);
    }
  }

  // DSH loads user-invoked skills from /name tokens in user text. Translate after
  // command dispatch so a $skill sharing a command name cannot execute that command.
  private resolveSkillMentions(prompt: AcpContentBlock[]): AcpContentBlock[] {
    return prompt.map((block) =>
      block.type !== "text" || !block.text.includes("$")
        ? block
        : {
            ...block,
            text: block.text.replace(
              /(^|\s)\$([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/gu,
              (match: string, prefix: string, name: string) =>
                this.advertisedSkills.has(name) ? `${prefix}/${name}` : match,
            ),
          },
    );
  }

  /** Admit, enqueue, and settle one prompt at whole-Agent quiescence. */
  async prompt(
    params: PromptRequest,
    imageEnabled: boolean,
    requestSignal?: AbortSignal,
  ): Promise<PromptResponse> {
    this.assertActive();
    if (this.inflight !== undefined)
      throw invalidParams("a prompt is already in flight for this session");
    const completion = Promise.withResolvers<StopReason>();
    const admission = Promise.withResolvers<void>();
    const admissionController = new AbortController();
    const inflight: InflightPrompt = {
      resolve: completion.resolve,
      reject: completion.reject,
      messageId: undefined,
      messageQueued: false,
      turn: undefined,
      endReason: undefined,
      admissionDone: admission.promise,
      finishAdmission: admission.resolve,
      admissionController,
      cancellationDone: Promise.withResolvers<void>(),
      cancelStartedIdle: false,
      settlementStarted: false,
      outputError: undefined,
      agentError: undefined,
    };
    this.inflight = inflight;
    const onRequestAbort = (): void => {
      this.cancelPrompt("ACP prompt request cancelled");
    };
    requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
    if (requestSignal?.aborted === true) onRequestAbort();
    try {
      let admissionFailure: unknown;
      try {
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError("prompt was not queued: the agent was disposed outside the bridge");
        }
        const signal = admissionController.signal;
        signal.throwIfAborted();
        if (await this.executeCommand(params.prompt, signal)) {
          inflight.endReason = { kind: "completed" };
        } else {
          const content = await admitAcpPrompt(
            this.ctx,
            this.agent.model.current(),
            this.resolveSkillMentions(params.prompt),
            imageEnabled,
            signal,
          );
          signal.throwIfAborted();
          if (this.ctx.agents.get(this.agent.id) !== this.agent) {
            throw internalError("prompt was not queued: the agent was disposed outside the bridge");
          }
          const message = dshRuntime().llm.createUserMessage({
            content,
            source: { kind: "user" },
          });
          inflight.messageId = message.id;
          inflight.messageQueued = true;
          try {
            this.agent.followup(message);
          } catch (error: unknown) {
            inflight.messageQueued = false;
            throw error;
          }
        }
      } catch (error: unknown) {
        admissionFailure = error;
      } finally {
        inflight.finishAdmission();
      }

      if (inflight.admissionController.signal.aborted) {
        this.settleAfterQuiescence(inflight);
        return { stopReason: await completion.promise };
      }
      if (admissionFailure !== undefined) {
        this.inflight = undefined;
        if (admissionFailure instanceof AcpContentError) {
          throw admissionFailure.kind === "invalid"
            ? invalidParams(admissionFailure.message)
            : internalError(admissionFailure.message);
        }
        if (admissionFailure instanceof dshRuntime().sdk.RequestError) throw admissionFailure;
        throw internalError(`prompt was not queued: ${(admissionFailure as Error).message}`);
      }

      this.settleAfterQuiescence(inflight);
      return { stopReason: await completion.promise };
    } finally {
      requestSignal?.removeEventListener("abort", onRequestAbort);
    }
  }

  /** Cancel the active prompt, or autonomous work when no ACP prompt exists. */
  cancel(): void {
    const inflight = this.inflight;
    this.cancelPrompt("ACP prompt cancelled");
    if (inflight === undefined) this.agent.cancel({ kind: "user" });
  }

  /** Process one durable event and enqueue its standard ACP projections. */
  onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === "turn/start" && this.inflight?.turn !== undefined) {
      this.inflight.turn = event.data.turn;
      this.inflight.endReason = undefined;
    }
    try {
      if (
        event.type === "permission/preset" ||
        event.type === "sandbox/mode" ||
        event.type === "approval/policy"
      ) {
        // DSH appends intent first, then writes both knobs synchronously. Wait for
        // the settled projection, even if no matching knob event was necessary.
        queueMicrotask(() => {
          try {
            this.publishModeChange();
          } catch (error) {
            this.ctx.logger.warn(
              `acp: permission mode update failed: ${dshRuntime().llm.errorChain(error)}`,
            );
          }
        });
      } else if (event.type === "assistant/message") {
        const inflight = this.inflight?.turn === event.data.turn ? this.inflight : undefined;
        const signal = this.inflight?.admissionController.signal;
        const previous = this.outputTail;
        const delivery = previous.then(async () => {
          if (this.closing || signal?.aborted) return;
          for (const update of await assistantUpdates(this.ctx, session, event)) {
            if (this.closing || signal?.aborted) return;
            await this.notify({ sessionId: this.agent.session.id, update });
          }
        });
        this.outputTail = delivery.catch((error: unknown) => {
          const failure = error as Error;
          if (inflight !== undefined) inflight.outputError ??= failure;
          this.ctx.logger.warn(
            `acp: assistant output conversion failed: ${dshRuntime().llm.errorChain(error)}`,
          );
        });
      } else if (
        event.type === "compaction/start" ||
        event.type === "compaction/summary" ||
        event.type === "compaction/end" ||
        event.type === "compaction/prune" ||
        event.type === "tool/call" ||
        event.type === "tool/result" ||
        event.type === "todo/write" ||
        event.type === "turn/start"
      ) {
        // A committed compaction still changes context when its prompt is cancelled.
        const signal = event.type.startsWith("compaction/")
          ? undefined
          : this.inflight?.admissionController.signal;
        this.outputTail = this.outputTail
          .then(async () => {
            if (this.closing || signal?.aborted) return;
            const update = await this.activityUpdates.project(event);
            if (!update || this.closing || signal?.aborted) return;
            await this.notify({ sessionId: session.id, update });
          })
          .catch((error: unknown) => {
            this.ctx.logger.warn(
              `acp: ${event.type} update delivery failed: ${dshRuntime().llm.errorChain(error)}`,
            );
          });
      }
    } finally {
      const inflight = this.inflight;
      if (
        inflight !== undefined &&
        event.type === "turn/end" &&
        inflight.turn === event.data.turn
      ) {
        inflight.endReason = event.data.reason;
        inflight.agentError = undefined;
      }
    }
  }

  /** Correlate an accepted user message with its Agent turn. */
  onInboxClaimed(message: UserMessage, turn: number): void {
    if (this.inflight !== undefined && this.inflight.messageId === message.id)
      this.inflight.turn = turn;
  }

  /** Correlate an Agent interval failure with the active ACP prompt. */
  onAgentError(error: unknown): void {
    const inflight = this.inflight;
    if (inflight === undefined || !inflight.messageQueued) return;
    inflight.agentError = new Error(dshRuntime().llm.errorChain(error));
    this.settleAfterQuiescence(inflight);
  }

  onAgentStatus(status: string): void {
    const inflight = this.inflight;
    if (!inflight?.messageQueued || !inflight.admissionController.signal.aborted) return;
    if (status === "idle" || inflight.cancelStartedIdle)
      inflight.cancellationDone.resolve(this.outputTail);
  }

  /** Await every update queued before this call. */
  drainUpdates(): Promise<void> {
    return this.outputTail;
  }

  /** Cancel, drain, flush, and dispose this session once. */
  close(detail: string): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closing = (async () => {
      const failures: unknown[] = [];
      const inflight = this.inflight;
      this.cancelPrompt(detail);
      if (inflight === undefined || !inflight.messageQueued) this.agent.cancel({ kind: "user" });
      try {
        await inflight?.admissionDone;
        await this.agent.whenIdle();
        await this.outputTail;
      } catch (error: unknown) {
        failures.push(new Error("ACP session activity drain failed", { cause: error }));
      }
      const subagents = this.ctx.get("subagents");
      try {
        if (typeof subagents?.drainDescendants === "function")
          await subagents.drainDescendants([this.agent]);
        else
          this.ctx.logger.warn(
            "acp: subagents.drainDescendants unavailable, skipping descendant teardown",
          );
      } catch (error: unknown) {
        this.ctx.logger.warn(
          `acp: subagent teardown failed: ${dshRuntime().llm.errorChain(error)}`,
        );
        failures.push(new Error("subagent teardown failed", { cause: error }));
      }
      try {
        await this.ctx.sessions.flush(this.agent.session);
      } catch (error: unknown) {
        failures.push(new Error("ACP session persistence flush failed", { cause: error }));
      }
      try {
        await this.disposeAgent();
      } catch (error: unknown) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          `ACP session teardown failed: ${failures.map(dshRuntime().llm.errorChain).join("; ")}`,
        );
      }
    })();
    return this.closing;
  }

  private assertActive(): void {
    if (this.closing !== undefined)
      throw invalidParams(`session is closing: ${this.agent.session.id}`);
  }

  private cancelPrompt(detail: string): void {
    const inflight = this.inflight;
    if (inflight === undefined) return;
    const firstCancellation = !inflight.admissionController.signal.aborted;
    if (firstCancellation) inflight.cancelStartedIdle = this.agent.status === "idle";
    inflight.admissionController.abort(new Error(detail));
    this.settleAfterQuiescence(inflight);
    if (!inflight.messageQueued) {
      inflight.cancellationDone.resolve();
      return;
    }
    this.agent.cancel({ kind: "user" });
    if (firstCancellation) {
      const done = inflight.cancellationDone;
      void this.agent.whenIdle().then(() => done.resolve(this.outputTail), done.reject);
    }
  }

  private settleAfterQuiescence(inflight: InflightPrompt): void {
    if (inflight.settlementStarted) return;
    inflight.settlementStarted = true;
    void (async () => {
      await inflight.admissionDone;
      if (inflight.messageQueued) {
        const subagents = this.ctx.get("subagents");
        const waitForTree =
          typeof subagents?.waitForTreeWork === "function"
            ? subagents.waitForTreeWork.bind(subagents)
            : undefined;
        if (!waitForTree)
          this.ctx.logger.warn("acp: subagents.waitForTreeWork unavailable, waiting for root only");
        const cancelled = inflight.cancellationDone.promise;
        const signal = inflight.admissionController.signal;
        const idleAt = (seq: number) =>
          this.agent.status === "idle" && this.agent.session.seq === seq;
        while (true) {
          await Promise.race([this.agent.whenIdle(), cancelled]);
          if (signal.aborted) break;
          const seq = this.agent.session.seq;
          const children = await Promise.race([waitForTree?.(this.agent), cancelled]);
          if (signal.aborted) break;
          if (children || !idleAt(seq)) continue;
          await this.outputTail;
          if (signal.aborted || idleAt(seq)) break;
        }
        if (signal.aborted) await cancelled;
      }
      if (this.inflight !== inflight) return;
      this.inflight = undefined;
      if (inflight.admissionController.signal.aborted) {
        inflight.resolve("cancelled");
        return;
      }
      if (inflight.outputError !== undefined) {
        inflight.reject(
          internalError(`assistant output delivery failed: ${inflight.outputError.message}`),
        );
        return;
      }
      if (inflight.agentError !== undefined) {
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`));
        return;
      }
      const end = inflight.endReason;
      if (end === undefined) {
        inflight.resolve("cancelled");
      } else if (end.kind === "error") {
        inflight.reject(internalError(`turn failed: ${end.error.message}`));
      } else {
        inflight.resolve(turnEndToStopReason(end));
      }
    })().catch((error: unknown) => {
      if (this.inflight !== inflight) return;
      this.inflight = undefined;
      inflight.reject(
        internalError(`prompt settlement failed: ${dshRuntime().llm.errorChain(error)}`),
      );
    });
  }
}
