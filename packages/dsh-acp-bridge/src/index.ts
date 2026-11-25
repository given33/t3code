import type {
  Context,
  AgentContext,
  AuthenticateRequest,
  CancelNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SessionNotification,
  Stream,
  SessionId,
} from "./host.js";
import { loadDshRuntime } from "./dshRuntime.js";
/** Automation-only Agent Client Protocol server over JSON-RPC stdio. */

import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import { supportsAcpImagePrompts } from "./content.ts";
import { AcpMcpConfigError } from "./mcp.ts";
import { AcpModelConfigError } from "./model-control.ts";
import { AcpSession } from "./session.ts";

const { Buffer } = NodeBuffer;
const { randomUUID } = NodeCrypto;
const { realpath } = NodeFSP;
const { isAbsolute, resolve } = NodePath;
const { Readable, Writable } = NodeStream;

const {
  schema: { default: Schema },
  brand: { brandString },
  llm: { errorChain },
  sdk: { agent: createAcpAgentApp, methods, ndJsonStream, PROTOCOL_VERSION, RequestError },
} = await loadDshRuntime();

const DEFAULT_SESSION_LIST_PAGE_SIZE = 100;

export const name = "t3-dsh-acp";
/** Core services required by the standard automation controls. */
export const inject = ["agents", "llm", "sessionPersistence", "sessions"];

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail: string): Error {
  return RequestError.invalidParams(undefined, detail);
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail: string): Error {
  return RequestError.internalError(undefined, detail);
}

/** Plugin config: the provider/model selection used for each ACP-created agent. */
export interface AcpConfig {
  /** Provider route for created agents. */
  provider?: string;
  /** Model name for created agents. */
  model?: string;
  /** Maximum summaries returned by one session/list page. */
  sessionListPageSize?: number;
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream;
}

export const Config = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  sessionListPageSize: Schema.natural().min(1).default(DEFAULT_SESSION_LIST_PAGE_SIZE),
});

/** Mount the automation-only ACP server. */
export function apply(ctx: Context, config: AcpConfig): void {
  // ACP handlers execute outside this plugin's injection scope, so capture the
  // injected service during apply rather than reading it lazily in a callback.
  const persistence = ctx.sessionPersistence;
  const logger = ctx.logger;
  const sessionListPageSize = resolveSessionListPageSize(config.sessionListPageSize);
  const sessions = new Map<SessionId, AcpSession>();
  const activating = new Set<SessionId>();
  let closed = false;
  let imagePromptEnabled = false;
  let warnedMissingPresets = false;
  const sessionModes = (record: AcpSession) => {
    const modes = record.modes();
    if (modes) return { modes };
    if (!warnedMissingPresets) {
      warnedMissingPresets = true;
      logger.warn("acp: permissionPresets unavailable, omitting session modes");
    }
    return {};
  };

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
  const ownedRecord = (agent: Parameters<AcpSession["owns"]>[0]): AcpSession | undefined => {
    const record = sessions.get(agent.session.id);
    return record?.owns(agent) === true ? record : undefined;
  };

  const assertOpen = (): void => {
    if (closed) throw internalError("the ACP bridge has been disposed");
  };

  const requireSession = (sessionId: SessionId): AcpSession => {
    const record = sessions.get(sessionId);
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`);
    return record;
  };

  /** Send one ordered protocol update while containing transport-only failure. */
  const notify = async (notification: SessionNotification): Promise<void> => {
    try {
      await conn.notify(methods.client.session.update, notification);
    } catch (error: unknown) {
      logger.warn(`acp: session/update failed: ${String(error)}`);
    }
  };

  ctx.on("session/event", (session, event) => {
    const record = sessions.get(session.header.id);
    if (record?.ownsSession(session) === true) record.onSessionEvent(session, event);
  });

  ctx.on("agent/inbox/claimed", ({ agent, message, turn }) => {
    ownedRecord(agent)?.onInboxClaimed(message, turn);
  });

  ctx.on("agent/error", ({ agent, error }) => {
    ownedRecord(agent)?.onAgentError(error);
  });

  ctx.on("agent/status", ({ agent, status }) => {
    ownedRecord(agent)?.onAgentStatus(status);
  });

  if (ctx.get("commands") && typeof ctx.on === "function") {
    ctx.on("commands/change", () => {
      for (const record of sessions.values()) void record.advertiseCommands();
    });
  } else logger.warn("acp: commands/change unavailable, skipping command updates");

  ctx.on("llm/adapters-updated", () => {
    for (const record of sessions.values()) record.topologyChanged();
  });

  // Permission requests are a machine policy channel for ACP clients such as
  // dsh-subagent-acp. The bridge offers one-shot choices only and never infers a
  // durable grant from an unknown client response.
  ctx.on("approval/request", (request, next) => {
    const record = ownedRecord(request.agent);
    if (record === undefined || request.callId === undefined) return next();
    const callId = request.callId;
    return record
      .drainUpdates()
      .then(() => {
        const params: RequestPermissionRequest = {
          sessionId: record.agent.session.id,
          toolCall: { toolCallId: callId },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        };
        return conn.request(methods.client.session.requestPermission, params);
      })
      .then(({ outcome }) => {
        if (outcome.outcome === "cancelled") return "cancelled";
        return outcome.optionId === "allow-once" ? "allowed-once" : "rejected";
      });
  });

  const implementation = {
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      // Single-version agent: the spec's "same version if supported, else
      // the latest supported" both resolve to this server's one version.
      imagePromptEnabled = await supportsAcpImagePrompts(ctx, config.provider, config.model);
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: "t3-deepseek-harness-acp", version: "0.1.0-t3" },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      };
    },

    authenticate(_params: AuthenticateRequest): Promise<void> {
      return Promise.resolve();
    },

    async newSession(params: NewSessionRequest, signal: AbortSignal): Promise<NewSessionResponse> {
      assertOpen();
      validateWorkspaceParams(params);
      const sessionId = brandString<SessionId>(randomUUID());
      // No preset composition: the ACP bundle keeps the model-facing rows in
      // the host plane, so this agent reads them from the global layer. A
      // deployment that configures a roster has to join one here first
      // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
      let record: AcpSession;
      try {
        record = await AcpSession.create(ctx, {
          sessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers,
          agentOptions: agentOptions(config),
          signal,
          notify,
        });
      } catch (error: unknown) {
        if (error instanceof AcpMcpConfigError) throw invalidParams(error.message);
        throw error;
      }
      if (closed) {
        await record.close("connection closed during session/new");
        throw internalError("connection closed during session/new");
      }
      sessions.set(sessionId, record);
      try {
        const configOptions = await record.configOptions(signal);
        assertOpen();
        // The attached log writer's flush materializes an empty session durably.
        await ctx.sessions.flush(record.agent.session);
        assertOpen();
        await record.advertiseCommands(signal);
        return { sessionId, configOptions, ...sessionModes(record) };
      } catch (error: unknown) {
        sessions.delete(sessionId);
        await record.close("session/new activation failed");
        throw error;
      }
    },

    async resumeSession(
      params: ResumeSessionRequest,
      signal: AbortSignal,
    ): Promise<ResumeSessionResponse> {
      assertOpen();
      validateWorkspaceParams(params);
      const sessionId = brandString<SessionId>(params.sessionId);
      if (
        sessions.has(sessionId) ||
        activating.has(sessionId) ||
        ctx.sessions.get(sessionId) !== undefined
      ) {
        throw invalidParams(`session is already active: ${sessionId}`);
      }
      activating.add(sessionId);
      return (async (): Promise<ResumeSessionResponse> => {
        const persisted = (await persistence.stat(sessionId, { signal }))?.header;
        if (persisted === undefined || persisted.origin === "subagent") {
          throw invalidParams(`session is not resumable: ${sessionId}`);
        }
        if (!(await sameDirectory(persisted.cwd, params.cwd))) {
          throw invalidParams(`session cwd does not match: ${params.cwd}`);
        }
        let record: AcpSession;
        try {
          record = await AcpSession.resume(ctx, {
            sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            agentOptions: agentOptions(config),
            signal,
            notify,
          });
        } catch (error: unknown) {
          if (error instanceof AcpMcpConfigError) throw invalidParams(error.message);
          throw error;
        }
        if (!(await sameDirectory(record.agent.session.header.cwd, params.cwd))) {
          await record.close("session/resume cwd mismatch");
          throw invalidParams(`session cwd does not match: ${params.cwd}`);
        }
        if (closed) {
          await record.close("connection closed during session/resume");
          throw internalError("connection closed during session/resume");
        }
        sessions.set(sessionId, record);
        try {
          const configOptions = await record.configOptions(signal);
          await record.advertiseCommands(signal);
          return { configOptions, ...sessionModes(record) };
        } catch (error: unknown) {
          sessions.delete(sessionId);
          await record.close("session/resume option discovery failed");
          throw error;
        }
      })().finally(() => {
        activating.delete(sessionId);
      });
    },

    async listSessions(
      params: ListSessionsRequest,
      signal: AbortSignal,
    ): Promise<ListSessionsResponse> {
      assertOpen();
      if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
        throw invalidParams(`cwd must be an absolute path: ${params.cwd}`);
      }
      let cursor: SessionListCursor | undefined;
      try {
        cursor = decodeSessionListCursor(params.cursor);
      } catch (error: unknown) {
        throw invalidParams((error as Error).message);
      }
      const listed = await persistence.list({ signal });
      const filtered = await Promise.all(
        listed.map(async ({ header }) => {
          if (
            sessions.has(header.id) ||
            activating.has(header.id) ||
            ctx.sessions.get(header.id) !== undefined ||
            header.origin === "subagent" ||
            header.cwd === undefined ||
            !isAbsolute(header.cwd)
          )
            return undefined;
          if (
            params.cwd !== undefined &&
            params.cwd !== null &&
            !(await sameDirectory(header.cwd, params.cwd))
          ) {
            return undefined;
          }
          return { sessionId: header.id, cwd: header.cwd, createdAt: header.createdAt };
        }),
      );
      const entries = filtered
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        .sort(
          (left, right) =>
            right.createdAt - left.createdAt || compareSessionIds(left.sessionId, right.sessionId),
        );
      const remaining =
        cursor === undefined
          ? entries
          : entries.filter((entry) => isAfterSessionListCursor(entry, cursor));
      const page = remaining.slice(0, sessionListPageSize);
      const next = remaining.length > page.length ? page.at(-1) : undefined;
      return {
        sessions: page.map(({ sessionId, cwd }) => ({ sessionId, cwd })),
        ...(next === undefined ? {} : { nextCursor: encodeSessionListCursor(next) }),
      };
    },

    async setSessionConfigOption(
      params: SetSessionConfigOptionRequest,
      signal: AbortSignal,
    ): Promise<SetSessionConfigOptionResponse> {
      assertOpen();
      const record = requireSession(brandString<SessionId>(params.sessionId));
      try {
        return { configOptions: await record.setConfig(params.configId, params.value, signal) };
      } catch (error: unknown) {
        if (error instanceof AcpModelConfigError) throw invalidParams(error.message);
        throw error;
      }
    },

    async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
      assertOpen();
      const sessionId = brandString<SessionId>(params.sessionId);
      const record = requireSession(sessionId);
      try {
        await record.close("ACP session closed");
      } catch (error: unknown) {
        throw internalError(`session close failed: ${errorChain(error)}`);
      } finally {
        if (sessions.get(sessionId) === record) sessions.delete(sessionId);
      }
      return {};
    },

    async prompt(params: PromptRequest, requestSignal: AbortSignal): Promise<PromptResponse> {
      assertOpen();
      const record = requireSession(brandString<SessionId>(params.sessionId));
      return record.prompt(params, imagePromptEnabled, requestSignal);
    },

    cancel(params: CancelNotification): Promise<void> {
      sessions.get(brandString<SessionId>(params.sessionId))?.cancel();
      return Promise.resolve();
    },
  };

  const stream: Stream =
    config.stream ??
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    );
  const app = createAcpAgentApp({ name: "t3-deepseek-harness-acp" })
    .onRequest(methods.agent.initialize, ({ params }) => implementation.initialize(params))
    .onRequest(methods.agent.authenticate, async ({ params }) => {
      await implementation.authenticate(params);
      return {};
    })
    .onRequest(methods.agent.session.new, ({ params, signal }) =>
      implementation.newSession(params, signal),
    )
    .onRequest(methods.agent.session.list, ({ params, signal }) =>
      implementation.listSessions(params, signal),
    )
    .onRequest(methods.agent.session.resume, ({ params, signal }) =>
      implementation.resumeSession(params, signal),
    )
    .onRequest(methods.agent.session.close, ({ params }) => implementation.closeSession(params))
    .onRequest(methods.agent.session.setMode, async ({ params }) => {
      assertOpen();
      await requireSession(brandString<SessionId>(params.sessionId)).setMode(params.modeId);
      return {};
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params, signal }) =>
      implementation.setSessionConfigOption(params, signal),
    )
    .onRequest(methods.agent.session.prompt, ({ params, signal }) =>
      implementation.prompt(params, signal),
    )
    .onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params));
  const connection = app.connect(stream);
  const conn: AgentContext = connection.client;

  let quiescing: Promise<void> | undefined;
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing;
    closed = true;
    const records = [...sessions.values()];
    // AcpSession.close cancels synchronously before its first await, so every owned
    // prompt stops before any descendant or persistence drain can block.
    quiescing = (async () => {
      const disposals = await Promise.allSettled(
        records.map((record) => record.close("ACP bridge disposed")),
      );
      for (const record of records) {
        if (sessions.get(record.agent.session.id) === record)
          sessions.delete(record.agent.session.id);
      }
      const failures: unknown[] = [];
      for (const result of disposals) {
        if (result.status === "rejected") failures.push(result.reason as unknown);
      }
      if (failures.length > 0) {
        // The production consumer logs this AggregateError through `String`,
        // which renders only its message. Embed every per-session diagnostic,
        // including nested causes and aggregate members, in that message.
        const detail = failures.map((failure) => errorChain(failure)).join("; ");
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${detail}`,
        );
      }
    })();
    return quiescing;
  };

  void connection.closed
    .catch((error: unknown) => {
      logger.warn(`acp: connection closed with an error: ${String(error)}`);
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp: connection-close teardown failed: ${String(error)}`);
    });

  ctx.effect(() => quiesce, "acp.connection");
}

/** Build per-agent options from plugin config without assigning absent optional fields. */
function agentOptions(config: AcpConfig): { provider?: string; model?: string } {
  return {
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
  };
}

interface SessionListCursor {
  createdAt: number;
  sessionId: string;
}

/** Resolve and validate the deployment-owned session page limit. */
function resolveSessionListPageSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_SESSION_LIST_PAGE_SIZE;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error("acp: sessionListPageSize must be a positive safe integer");
  }
  return resolved;
}

/** Decode an opaque keyset cursor without assigning meaning to client metadata. */
function decodeSessionListCursor(value: string | null | undefined): SessionListCursor | undefined {
  if (value === undefined || value === null) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("session/list cursor is invalid");
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const createdAt: unknown = Array.isArray(decoded) ? decoded[0] : undefined;
    const sessionId: unknown = Array.isArray(decoded) ? decoded[1] : undefined;
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof createdAt !== "number" ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      typeof sessionId !== "string" ||
      sessionId.length === 0
    )
      throw new Error("invalid cursor fields");
    const canonical = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    if (canonical !== value) throw new Error("non-canonical cursor");
    return { createdAt, sessionId };
  } catch (cause) {
    throw new Error("session/list cursor is invalid", { cause });
  }
}

/** Encode the last returned ordering key as an opaque continuation token. */
function encodeSessionListCursor(entry: SessionListCursor): string {
  return Buffer.from(JSON.stringify([entry.createdAt, entry.sessionId]), "utf8").toString(
    "base64url",
  );
}

/** Test whether an entry follows the cursor in newest-first list order. */
function isAfterSessionListCursor(entry: SessionListCursor, cursor: SessionListCursor): boolean {
  return (
    entry.createdAt < cursor.createdAt ||
    (entry.createdAt === cursor.createdAt &&
      compareSessionIds(entry.sessionId, cursor.sessionId) > 0)
  );
}

/** Compare opaque session ids by stable UTF-8 bytes, independent of process locale. */
function compareSessionIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/** Reject workspace features outside the automation contract. */
function validateWorkspaceParams(params: {
  cwd: string;
  additionalDirectories?: string[] | null;
}): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`);
  if (
    params.additionalDirectories !== undefined &&
    params.additionalDirectories !== null &&
    params.additionalDirectories.length > 0
  ) {
    throw invalidParams("additionalDirectories is not supported");
  }
}

/** Compare existing directories by physical identity and missing paths lexically. */
async function sameDirectory(left: string | undefined, right: string): Promise<boolean> {
  if (left === undefined) return false;
  try {
    const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)]);
    return realLeft === realRight;
  } catch (_unresolvablePath) {
    return resolve(left) === resolve(right);
  }
}
