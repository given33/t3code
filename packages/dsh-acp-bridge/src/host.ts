// Structural contracts for the services used from the installed DSH host.
export type SessionId = string;
export type StopReason = "end_turn" | "max_tokens" | "cancelled";
export type TurnEndReason =
  | { kind: "completed" | "max-tokens" | "aborted" | "interrupted" | "blocked" }
  | { kind: "error"; error: Error };
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}
export interface AgentModel {
  current(): ModelSelection | undefined;
  select(selection: ModelSelection): void;
}
export type LlmCallConfig = ModelSelection;
interface Choice {
  id: string;
  name: string;
  description?: string;
}
export interface LlmRuntime {
  listProviders(): Choice[];
  listModels(provider: string): Promise<Choice[]>;
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    inputModalities?: string[];
    reasoning?: { defaultEffort?: string; efforts: Choice[] };
  }>;
  resolveCallConfig(route: ModelSelection, signal?: AbortSignal): Promise<LlmCallConfig>;
}
export type AgentOptions = Partial<ModelSelection>;
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export interface ImageAttachmentRef {
  mediaType: ImageMediaType;
}
export interface SaveImageAttachment {
  mediaType: ImageMediaType;
  data: Uint8Array;
}
type Text = { type: "text"; text: string };
export type ContentBlock =
  | Text
  | { type: "reasoning"; text: string }
  | { type: "image"; attachment: ImageAttachmentRef }
  | { type: "tool_call" };
export type AcpContentBlock =
  | Text
  | { type: "resource_link"; name: string; uri: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio" | "resource" };
export interface UserMessage {
  id: string;
  content: ContentBlock[];
}
interface Header {
  id: SessionId;
  cwd?: string;
  origin?: string;
  createdAt: number;
}
export interface Session {
  id: string;
  header: Header;
  requestContext(): { contextWindow: number } | undefined;
  seq: number;
}
interface EventData {
  "compaction/start": { compactionId: string };
  "compaction/summary": { compactionId: string; summary: ContentBlock[] };
  "compaction/end": { compactionId: string; error?: string };
  "compaction/prune": unknown;
  "permission/preset": { preset: string };
  "sandbox/mode": unknown;
  "approval/policy": unknown;
  "turn/start": { turn: number };
  "assistant/message": { turn: number; message: UserMessage; usage?: unknown };
  "tool/call": { callId: string; name: string; arguments: string };
  "todo/write": { todos: { content: string; status: string }[] };
  "tool/result": {
    meta?: unknown;
    message: { toolCallId: string; isError?: boolean; content: ContentBlock[] };
  };
  "turn/end": { turn: number; reason: TurnEndReason };
}
export type SessionEvent<K extends keyof EventData = keyof EventData> = {
  [T in K]: { type: T; data: EventData[T] };
}[K];
export interface Agent {
  model: AgentModel;
  status: string;
  id: string;
  session: Session;
  steer?(message: UserMessage): void;
  followup(message: UserMessage): void;
  cancel(reason: { kind: "user" }): void;
  whenIdle(): Promise<void>;
}
export interface AgentHandle {
  agent: Agent;
  dispose(): Promise<void>;
}
interface Setup {
  agentOptions: AgentOptions;
  signal: AbortSignal;
  setup: (ctx: Context) => Promise<void>;
}
export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string };
}
type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "fetch" | "other";
export interface FileLocation {
  path: string;
  line?: number;
}
export interface FileDiff {
  path: string;
  oldText: string | null;
  newText: string;
}
export interface ToolDefinition {
  presentCall?(args: unknown):
    | {
        card: "generic";
        title: string;
        kind?: ToolKind;
        rawInput?: unknown;
        content?: ContentBlock[];
        locations?: FileLocation[];
      }
    | { card: "terminal"; title: string }
    | { card: "diff"; title: string; diffs: FileDiff[]; locations?: FileLocation[] }
    | undefined;
  presentResult?(
    args: unknown,
    result: { content: ContentBlock[]; isError: boolean; meta?: unknown },
  ):
    | { card: "generic" | "read"; content?: ContentBlock[] }
    | { card: "terminal"; output?: string }
    | { card: "diff"; diffs: FileDiff[] }
    | { card: "search" | "web" }
    | undefined;
}
interface Services {
  permissionPresets: {
    readonly names: readonly string[];
    current(session: Session): string;
    optionOf(name: string): { name: string; description?: string };
    set(session: Session, name: string): void;
  };
  tools: {
    get(name: string, scope: Agent): ToolDefinition | undefined;
    restrict?(filter: { allow: string[] }): unknown;
    schemas?(scope: Agent): unknown[];
  };
  commands: {
    list(agent: Agent): readonly AvailableCommand[];
    execute(
      agent: Agent,
      line: string,
      attachments: [],
      signal: AbortSignal,
    ): Promise<
      | {
          commandId: string;
          result: { kind: "success" | "error"; text?: string };
        }
      | undefined
    >;
  };
  skills: {
    list(options: {
      scope: Agent;
      cwd?: string;
      signal?: AbortSignal;
    }): Promise<readonly { name: string; description: string }[]>;
  };
  llm: LlmRuntime;
  attachments: {
    imageLimits: { mediaTypes: ImageMediaType[] };
    saveImages(images: SaveImageAttachment[]): Promise<ImageAttachmentRef[]>;
    readImage(ref: ImageAttachmentRef): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>;
  };
  tokenMeter: { measure(session: Session): { totalTokens: number } };
  subagents: {
    drainDescendants?(parents: readonly Agent[]): Promise<void>;
    waitForTreeWork?(agent: Agent): Promise<boolean>;
  };
  fs: {
    resolve(path: string, options: { signal: AbortSignal }): Promise<unknown>;
    processPath(path: unknown): string;
  };
}
interface Events {
  "commands/change": [];
  "session/event": [Session, SessionEvent];
  "agent/inbox/claimed": [{ agent: Agent; message: UserMessage; turn: number }];
  "agent/error": [{ agent: Agent; error: unknown }];
  "agent/status": [{ agent: Agent; status: string }];
  "llm/adapters-updated": [];
  "approval/request": [{ agent: Agent; callId?: string }, () => unknown];
}
export interface Context {
  llm: LlmRuntime;
  logger: { warn(message: string): void };
  sessions: { flush(session: Session): Promise<void>; get(id: string): Session | undefined };
  sessionPersistence: {
    stat(id: string, options: { signal: AbortSignal }): Promise<{ header: Header } | undefined>;
    list(options: { signal: AbortSignal }): Promise<{ header: Header }[]>;
  };
  agents: {
    create(options: Setup & { sessionId: string; meta: { cwd: string } }): Promise<AgentHandle>;
    resume(options: Setup & { resumeSessionId: string }): Promise<AgentHandle>;
    get(id: string): Agent | undefined;
  };
  get<K extends keyof Services>(key: K): Services[K] | undefined;
  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => unknown): void;
  effect(callback: () => () => Promise<void>, label: string): void;
  plugin(plugin: unknown, config: McpConfig): Promise<unknown>;
}
interface Entry {
  name: string;
  value: string;
}
export type McpServer =
  | { name: string; command: string; args: string[]; env: Entry[] }
  | { type: "http" | "sse"; name: string; url: string; headers: Entry[] };
export interface McpConfig {
  transport: "stdio" | "streamable-http";
  serverName: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  failOnStartupError: boolean;
}
export type SessionConfigValueId = string;
interface SelectOption {
  value: string;
  name: string;
  description?: string;
}
export interface SessionConfigOption {
  id: string;
  type: "select";
  category: "model" | "thought_level";
  name: string;
  currentValue: string;
  options: SelectOption[] | { group: string; name: string; options: SelectOption[] }[];
}
export type ToolCallContent =
  | { type: "content"; content: AcpContentBlock }
  | ({ type: "diff" } & FileDiff);
export type PlanStatus = "pending" | "in_progress" | "completed";
export type SessionUpdate =
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
  | {
      sessionUpdate: "agent_message_chunk" | "agent_thought_chunk";
      messageId: string;
      content: AcpContentBlock;
    }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind: ToolKind;
      status: "pending";
      locations?: FileLocation[];
      content?: ToolCallContent[];
      rawInput: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status: "failed" | "completed";
      rawOutput?: unknown;
      content: ToolCallContent[];
    }
  | {
      sessionUpdate: "plan";
      entries: { content: string; status: PlanStatus; priority: "medium" }[];
    }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | {
      sessionUpdate: "compaction_update";
      compactionId: string;
      status: "in_progress" | "completed" | "failed";
      summary?: AcpContentBlock[];
      error?: string;
    }
  | { sessionUpdate: "usage_update"; used: number; size: number }
  | { sessionUpdate: "config_option_update"; configOptions: SessionConfigOption[] };
export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}
export type InitializeRequest = unknown;
export interface InitializeResponse {
  _meta?: Record<string, unknown>;
  protocolVersion: number;
  agentInfo: { name: string; version: string };
  agentCapabilities: {
    mcpCapabilities: { http: boolean };
    promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
    sessionCapabilities: { close: object; list: object; resume: object };
  };
  authMethods: unknown[];
}
export type AuthenticateRequest = unknown;
interface Workspace {
  cwd: string;
  additionalDirectories?: string[] | null;
}
export interface NewSessionRequest extends Workspace {
  _meta?: Record<string, unknown>;
  mcpServers: McpServer[];
}
export interface NewSessionResponse extends ResumeSessionResponse {
  sessionId: string;
}
export interface ResumeSessionRequest extends Workspace {
  sessionId: string;
  mcpServers?: McpServer[];
}
export interface SessionModeState {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string }[];
}
export interface ResumeSessionResponse {
  modes?: SessionModeState;
  configOptions: SessionConfigOption[];
}
export interface ListSessionsRequest {
  cwd?: string | null;
  cursor?: string | null;
}
export interface ListSessionsResponse {
  sessions: { sessionId: string; cwd: string }[];
  nextCursor?: string;
}
export interface CloseSessionRequest {
  sessionId: string;
}
export type CloseSessionResponse = Record<string, never>;
export type CancelNotification = CloseSessionRequest;
export interface SetSessionConfigOptionRequest {
  sessionId: string;
  configId: string;
  value: unknown;
}
export type SetSessionConfigOptionResponse = Pick<ResumeSessionResponse, "configOptions">;
export interface PromptRequest {
  sessionId: string;
  prompt: AcpContentBlock[];
}
export interface PromptResponse {
  stopReason: StopReason;
}
export interface RequestPermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string };
  options: { optionId: string; name: string; kind: "allow_once" | "reject_once" }[];
}
export interface AgentContext {
  notify(method: unknown, params: SessionNotification): Promise<void>;
  request(
    method: unknown,
    params: RequestPermissionRequest,
  ): Promise<{ outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } }>;
}
export interface Stream {
  readable: ReadableStream;
  writable: WritableStream;
}
interface Rpc<P, R> {
  readonly __params?: P;
  readonly __result?: R;
}
interface App {
  onRequest<P, R>(
    method: Rpc<P, R>,
    handler: (input: { params: P; signal: AbortSignal }) => Promise<R>,
  ): App;
  onNotification<P>(method: Rpc<P, void>, handler: (input: { params: P }) => Promise<void>): App;
  connect(stream: Stream): { client: AgentContext; closed: Promise<void> };
}
interface SchemaNode {
  min(value: number): SchemaNode;
  default(value: number): SchemaNode;
}
export interface DshRuntime {
  schema: {
    default: {
      object(fields: Record<string, SchemaNode>): unknown;
      string(): SchemaNode;
      natural(): SchemaNode;
    };
  };
  llm: {
    createUserMessage(input: { content: ContentBlock[]; source: { kind: "user" } }): UserMessage;
    errorChain(error: unknown): string;
  };
  attachment: { isImageAdmissionError(error: unknown): error is Error };
  brand: { brandString<T extends string>(id: string): T };
  agent: { installModelSelection(ctx: Context): void };
  mcp: { Config(config: McpConfig): McpConfig };
  sdk: {
    agent(options: { name: string }): App;
    RequestError: ErrorConstructor & {
      invalidParams(data: undefined, detail: string): Error;
      internalError(data: undefined, detail: string): Error;
    };
    ndJsonStream(write: WritableStream<Uint8Array>, read: ReadableStream<Uint8Array>): Stream;
    PROTOCOL_VERSION: number;
    methods: {
      agent: {
        initialize: Rpc<InitializeRequest, InitializeResponse>;
        authenticate: Rpc<AuthenticateRequest, object>;
        session: {
          new: Rpc<NewSessionRequest, NewSessionResponse>;
          list: Rpc<ListSessionsRequest, ListSessionsResponse>;
          resume: Rpc<ResumeSessionRequest, ResumeSessionResponse>;
          close: Rpc<CloseSessionRequest, CloseSessionResponse>;
          setMode: Rpc<{ sessionId: string; modeId: string }, Record<string, never>>;
          setConfigOption: Rpc<SetSessionConfigOptionRequest, SetSessionConfigOptionResponse>;
          prompt: Rpc<PromptRequest, PromptResponse>;
          cancel: Rpc<CancelNotification, void>;
        };
      };
      client: { session: { update: unknown; requestPermission: unknown } };
    };
  };
}
