import * as NodePath from "node:path";
import type {
  Agent,
  AssistantStreamFrame,
  ContentBlock,
  Context,
  FileDiff,
  FileLocation,
  SessionUpdate,
  ToolCallContent,
  ToolDefinition,
  Session,
  SessionEvent,
} from "./host.js";
/** Standard ACP updates derived from committed DSH session events. */

import { assistantBlockToAcp } from "./content.ts";

/** ACP chunks are append-only. After a gap or interleaved block, let the commit deliver the remaining suffix. */
export class AssistantStream {
  readonly sent = { text: "", reasoning: "" };
  private next = 0;
  private deferred = false;
  private open: { index: number; text: string } | undefined;
  private readonly closed = new Set<number>();
  private pendingBreak = "";

  constructor(readonly start: Extract<AssistantStreamFrame, { type: "start" }>) {}

  chunk(frame: Extract<AssistantStreamFrame, { type: "chunk" }>): SessionUpdate | undefined {
    if (this.deferred || frame.index < this.next) return;
    const chunk = frame.chunk;
    if (frame.index !== this.next++) this.deferred = true;
    if (this.deferred || !("index" in chunk) || this.closed.has(chunk.index)) return;
    if (this.open && this.open.index !== chunk.index) {
      this.deferred = true;
      return;
    }
    this.open ??= { index: chunk.index, text: "" };
    if (chunk.type === "block-end") {
      const block = chunk.block;
      this.deferred =
        block.type === "image" ||
        ((block.type === "text" || block.type === "reasoning") && block.text !== this.open.text);
      this.closed.add(chunk.index);
      this.open = undefined;
      this.pendingBreak = "";
      return;
    }
    if ((chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") || !chunk.text) return;
    const thought = chunk.type === "reasoning-delta";
    let text = this.pendingBreak + chunk.text;
    this.pendingBreak = "";
    // pi-ai emits a paragraph break for summary_part.done and removes the last one at block-end.
    if (thought && text.endsWith("\n")) {
      this.pendingBreak = text.endsWith("\n\n") ? "\n\n" : "\n";
      text = text.slice(0, -this.pendingBreak.length);
    }
    if (!text) return;
    this.open.text += text;
    this.sent[thought ? "reasoning" : "text"] += text;
    return {
      sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
      messageId: this.start.attemptId,
      content: { type: "text", text },
    };
  }
}

/** Convert one committed assistant message and its context usage in block order. */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<"assistant/message">,
  stream?: AssistantStream,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = [];
  const messageId = stream?.start.attemptId ?? event.data.message.id;
  const pending = { ...stream?.sent };
  for (let block of event.data.message.content) {
    if (block.type === "text" || block.type === "reasoning") {
      const prefix = pending[block.type];
      if (prefix) {
        if (prefix.startsWith(block.text)) {
          pending[block.type] = prefix.slice(block.text.length);
          continue;
        }
        pending[block.type] = "";
        if (!block.text.startsWith(prefix)) {
          ctx.logger.warn(
            `acp: committed ${block.type} differs from its stream, keeping streamed output`,
          );
          continue;
        }
        block = { ...block, text: block.text.slice(prefix.length) };
      }
    }
    if (block.type === "reasoning") {
      if (block.text.length > 0) {
        updates.push({
          sessionUpdate: "agent_thought_chunk",
          messageId,
          content: { type: "text", text: block.text },
        });
      }
      continue;
    }
    const content = await assistantBlockToAcp(ctx, block);
    if (content !== undefined) {
      updates.push({
        sessionUpdate: "agent_message_chunk",
        messageId,
        content,
      });
    }
  }
  if (pending.text || pending.reasoning)
    ctx.logger.warn("acp: committed message is shorter than its stream, keeping streamed output");
  const usage = usageUpdate(ctx, session, event);
  if (usage !== undefined) updates.push(usage);
  return updates;
}

async function toolContent(ctx: Context, blocks: ContentBlock[]): Promise<ToolCallContent[]> {
  const content: ToolCallContent[] = [];
  for (const block of blocks) {
    const converted = await assistantBlockToAcp(ctx, block);
    if (converted !== undefined) content.push({ type: "content", content: converted });
  }
  return content;
}

export class SessionActivityUpdates {
  private readonly pending = new Map<
    string,
    { name: string; args: unknown; definition: ToolDefinition }
  >();
  // DSH permits only one open compaction. Retain just IDs after completion so
  // replayed starts/ends cannot reopen a transaction or retain old summaries.
  private readonly seenCompactions = new Set<string>();
  private compacting: { id: string; summary?: ContentBlock[] } | undefined;
  private readonly warned = new Set<string>();

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    private readonly cwd: string,
  ) {}

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ctx.logger.warn(message);
  }

  private locations(files: FileLocation[]): FileLocation[] {
    return files.map(({ path, line }) => ({
      path: NodePath.resolve(this.cwd, path),
      ...(line !== undefined && { line }),
    }));
  }

  private diffContent(diffs: FileDiff[]): ToolCallContent[] {
    return diffs.map(({ path, oldText, newText }) => ({
      type: "diff",
      path: NodePath.resolve(this.cwd, path),
      oldText,
      newText,
    }));
  }

  project(
    event: SessionEvent<
      | "tool/call"
      | "tool/result"
      | "todo/write"
      | "turn/start"
      | "compaction/start"
      | "compaction/summary"
      | "compaction/end"
      | "compaction/prune"
    >,
  ): SessionUpdate | Promise<SessionUpdate | undefined> {
    switch (event.type) {
      case "compaction/start":
      case "compaction/summary":
      case "compaction/end":
      case "compaction/prune":
        return this.compaction(event);
      case "tool/call":
        return this.call(event);
      case "tool/result":
        return this.result(event);
      case "todo/write":
        return this.plan(event.data.todos);
      case "turn/start":
        this.pending.clear();
        return { sessionUpdate: "plan", entries: [] };
    }
  }

  private async compaction(
    event: SessionEvent<
      "compaction/start" | "compaction/summary" | "compaction/end" | "compaction/prune"
    >,
  ): Promise<SessionUpdate | undefined> {
    if (event.type === "compaction/prune") {
      this.warnOnce("prune", "acp: compaction/prune has no ACP lifecycle update");
      return;
    }
    const { compactionId } = event.data;
    const frame = { sessionUpdate: "compaction_update", compactionId } as const;
    if (event.type === "compaction/start") {
      if (this.compacting || this.seenCompactions.has(compactionId)) return;
      this.seenCompactions.add(compactionId);
      this.compacting = { id: compactionId };
      return { ...frame, status: "in_progress" };
    }
    if (this.compacting?.id !== compactionId) return;
    if (event.type === "compaction/summary") {
      this.compacting.summary ??= event.data.summary;
      return;
    }
    const { summary } = this.compacting;
    this.compacting = undefined;
    // summary-error can recover and retry. Only end.error is terminal.
    if (event.data.error !== undefined)
      return { ...frame, status: "failed", error: event.data.error };
    const completed = { ...frame, status: "completed" } as const;
    if (!summary) return completed;
    try {
      const blocks = await Promise.all(summary.map((b) => assistantBlockToAcp(this.ctx, b)));
      return { ...completed, summary: blocks.filter((b) => b !== undefined) };
    } catch {
      this.ctx.logger.warn(
        "acp: could not convert compaction summary, sending completion without it",
      );
      return completed;
    }
  }

  private async call({ data }: SessionEvent<"tool/call">): Promise<SessionUpdate> {
    const args = parseToolArguments(data.arguments);
    const fallback = {
      sessionUpdate: "tool_call",
      toolCallId: data.callId,
      status: "pending",
      title: data.name,
      kind: "other",
      rawInput: args,
    } as const;
    const tools = this.ctx.get("tools");
    if (!tools) return fallback;
    try {
      const definition = tools.get(data.name, this.agent);
      if (definition?.presentResult)
        this.pending.set(data.callId, { name: data.name, args, definition });
      const view = definition?.presentCall?.(args);
      switch (view?.card) {
        case "terminal":
          return { ...fallback, kind: "execute", title: view.title };
        case "generic":
          return {
            ...fallback,
            title: view.title,
            kind: view.kind ?? "other",
            ...(view.rawInput !== undefined && { rawInput: view.rawInput }),
            ...(view.locations && { locations: this.locations(view.locations) }),
            ...(view.content && { content: await toolContent(this.ctx, view.content) }),
          };
        case "diff":
          return {
            ...fallback,
            kind: "edit",
            title: view.diffs[0]?.path ?? view.title,
            locations: this.locations(view.locations ?? view.diffs),
            content: this.diffContent(view.diffs),
          };
      }
      this.warnOnce(
        `call:${data.name}`,
        `acp: no usable presentCall for ${data.name}, using the tool name`,
      );
    } catch {
      this.warnOnce(
        `call:${data.name}`,
        `acp: presentCall failed for ${data.name}, using the tool name`,
      );
    }
    return fallback;
  }

  private async result({ data }: SessionEvent<"tool/result">): Promise<SessionUpdate> {
    const { message, meta } = data;
    const { toolCallId, content } = message;
    const isError = message.isError === true;
    const status: "failed" | "completed" = isError ? "failed" : "completed";
    const update = { sessionUpdate: "tool_call_update", toolCallId, status } as const;
    const call = this.pending.get(toolCallId);
    this.pending.delete(toolCallId);
    if (call) {
      try {
        const view = call.definition.presentResult?.(call.args, { content, isError, meta });
        let presented: ToolCallContent[] | undefined;
        if (view?.card === "terminal" && view.output !== undefined) {
          presented = [{ type: "content", content: { type: "text", text: view.output } }];
        } else if (view?.card === "diff") presented = this.diffContent(view.diffs);
        else if ((view?.card === "generic" || view?.card === "read") && view.content) {
          presented = await toolContent(this.ctx, view.content);
        }
        if (presented) return { ...update, content: presented, rawOutput: content };
      } catch {
        this.warnOnce(
          `result:${call.name}`,
          `acp: presentResult failed for ${call.name}, using the committed result`,
        );
      }
    }
    return { ...update, content: await toolContent(this.ctx, content) };
  }

  private plan(todos: SessionEvent<"todo/write">["data"]["todos"]): SessionUpdate {
    return {
      sessionUpdate: "plan",
      entries: todos.map(({ content, status }) => {
        if (status === "pending" || status === "in_progress" || status === "completed") {
          return { content, status, priority: "medium" };
        }
        this.warnOnce("todo-status", "acp: unknown todo status, using pending");
        return { content, status: "pending", priority: "medium" };
      }),
    };
  }
}

/** Report current context occupancy only when DSH has both usage and capacity facts. */
function usageUpdate(
  ctx: Context,
  session: Session,
  event: SessionEvent<"assistant/message">,
): SessionUpdate | undefined {
  if (event.data.usage === undefined) return undefined;
  if (typeof session.requestContext !== "function") {
    ctx.logger.warn("acp: session.requestContext unavailable, skipping usage update");
    return undefined;
  }
  const size = session.requestContext()?.contextWindow;
  const meter = ctx.get("tokenMeter");
  if (size === undefined) return undefined;
  if (typeof meter?.measure !== "function") {
    ctx.logger.warn("acp: tokenMeter.measure unavailable, skipping usage update");
    return undefined;
  }
  return {
    sessionUpdate: "usage_update",
    used: meter.measure(session).totalTokens,
    size,
  };
}

/** Preserve malformed model output as opaque input instead of dropping the call update. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (_invalidModelJson) {
    return value;
  }
}
