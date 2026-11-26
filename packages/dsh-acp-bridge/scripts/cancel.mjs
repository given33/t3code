import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import { drive, withWorkspace } from "./drive.mjs";
import { offlineProfile, startMock } from "./mock-llm.mjs";

await withWorkspace(async (cwd) => {
  const opened = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const textChunks = ["Offline stream ", "verified."];
  const mock = await startMock({
    textChunks,
    textOnly: true,
    async onTextStart({ step, res }) {
      if (step !== 0) return;
      const closed = NodeEvents.once(res, "close");
      opened.resolve();
      await closed;
      disconnected.resolve();
    },
  });
  try {
    const { variables } = await offlineProfile(cwd, true, mock);
    const { trace } = await drive({
      bridgeEnabled: true,
      cwd,
      variables,
      profile: "acp",
      onResponse(method, frame) {
        if (method === "session/prompt" || method === "session/close")
          console.log(JSON.stringify(frame));
      },
      async run({ request, notify, sessionId }) {
        const prompt = (text) =>
          request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
        const pending = prompt("Wait for cancellation");
        await Promise.race([
          opened.promise,
          pending.then(() => {
            throw new Error("Prompt ended before cancellation");
          }),
        ]);
        notify("session/cancel", { sessionId });
        // The delayed completion cannot resolve on its own. Require a real transport abort.
        const timeout = AbortSignal.timeout(5000);
        await Promise.race([
          Promise.all([pending, disconnected.promise]),
          new Promise((_, reject) =>
            timeout.addEventListener("abort", () => reject(timeout.reason), { once: true }),
          ),
        ]);
        NodeAssert.equal((await pending).stopReason, "cancelled");
        NodeAssert.equal((await prompt("Answer normally")).stopReason, "end_turn");
      },
    });
    const cancelAt = trace.findIndex((m) => m.method === "session/cancel");
    const next = trace.findIndex((m, i) => i > cancelAt && m.request === "session/prompt");
    const activity = (frames) =>
      frames.filter((m) =>
        ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(
          m.params?.update?.sessionUpdate,
        ),
      );
    NodeAssert.ok(cancelAt >= 0 && next > cancelAt);
    const leaked = activity(trace.slice(cancelAt, next));
    NodeAssert.deepEqual(leaked, []);
    const later = activity(trace.slice(next)).map((m) => m.params.update);
    NodeAssert.deepEqual(
      later.map((u) => [u.sessionUpdate, u.content?.text]),
      textChunks.map((text) => ["agent_message_chunk", text]),
    );
    NodeAssert.deepEqual(mock.seen.get("Bearer offline-t3"), ["text", "text"]);
    console.log(
      `SSE disconnected; post-cancel message/tool updates=${leaked.length}; next answer=${later.map((u) => u.content.text).join("")}`,
    );
    if (mock.failure) throw mock.failure;
  } catch (error) {
    throw mock.failure ?? error;
  } finally {
    await mock.close();
  }
});
