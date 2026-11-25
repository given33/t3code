import type { Context, SessionUpdate, ToolCallContent, Session, SessionEvent } from "./host.js";
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

/** Start one generic ACP tool lifecycle from the durable call fact. */
export function toolCallUpdate(event: SessionEvent<"tool/call">): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: event.data.callId,
    title: event.data.name,
    kind: "other",
    status: "in_progress",
    rawInput: parseToolArguments(event.data.arguments),
  };
}

/** Finish one generic ACP tool lifecycle from its committed model-facing result. */
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<"tool/result">,
): Promise<SessionUpdate> {
  const result = event.data.message;
  const content: ToolCallContent[] = [];
  for (const block of result.content) {
    const converted = await assistantBlockToAcp(ctx, block);
    if (converted !== undefined) content.push({ type: "content" as const, content: converted });
  }
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: result.toolCallId,
    status: result.isError === true ? "failed" : "completed",
    content,
  };
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
