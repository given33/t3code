import * as NodeFS from "node:fs";

export const name = "t3-stream-witness";
export function apply(ctx, { file }) {
  ctx.on("session/event", (_session, event) => {
    if (event.type === "assistant/message")
      NodeFS.writeFileSync(file, JSON.stringify(event.data.message.content));
  });
}
