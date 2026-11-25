import * as NodePath from "node:path";
import type {
  Agent,
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

/** Convert one committed assistant message and its context usage in block order. */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<"assistant/message">,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = [];
  for (const block of event.data.message.content) {
    if (block.type === "reasoning") {
      if (block.text.length > 0) {
        updates.push({
          sessionUpdate: "agent_thought_chunk",
          messageId: event.data.message.id,
          content: { type: "text", text: block.text },
        });
      }
      continue;
    }
    const content = await assistantBlockToAcp(ctx, block);
    if (content !== undefined) {
      updates.push({
        sessionUpdate: "agent_message_chunk",
        messageId: event.data.message.id,
        content,
      });
    }
  }
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
    event: SessionEvent<"tool/call" | "tool/result" | "todo/write" | "turn/start">,
  ): SessionUpdate | Promise<SessionUpdate> {
    switch (event.type) {
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
