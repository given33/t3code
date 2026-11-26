import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { drive, withWorkspace } from "./drive.mjs";
import { offlineProfile, startMock } from "./mock-llm.mjs";

await withWorkspace(async (root) => {
  const file = NodePath.join(root, "committed.json");
  const textChunks = ["First ", "second ", "third."],
    reasoningChunks = ["Consider ", "both paths."];
  const received = [];
  let acknowledge;
  const mock = await startMock({
    textOnly: true,
    textChunks,
    reasoningChunks,
    async afterDelta(kind, text) {
      const gate = Promise.withResolvers();
      acknowledge = (update) => {
        try {
          NodeAssert.equal(update.sessionUpdate, kind);
          NodeAssert.equal(update.content.text, text);
          gate.resolve();
        } catch (error) {
          gate.reject(error);
        }
      };
      const timeout = setTimeout(
        () => gate.reject(new Error(`No live ${kind} before commit`)),
        5000,
      );
      try {
        await gate.promise;
        await NodeAssert.rejects(NodeFSP.stat(file), { code: "ENOENT" });
      } finally {
        clearTimeout(timeout);
        acknowledge = undefined;
      }
    },
  });
  try {
    const { variables } = await offlineProfile(root, true, mock, [
      {
        insert: [
          {
            id: "stream-witness",
            name: new URL("./stream-witness.mjs", import.meta.url).href,
            config: { file },
          },
        ],
      },
    ]);
    await drive({
      bridgeEnabled: true,
      cwd: root,
      variables,
      profile: "acp",
      onUpdate(update) {
        if (["agent_thought_chunk", "agent_message_chunk"].includes(update.sessionUpdate)) {
          received.push(update);
          acknowledge?.(update);
        }
      },
      async run({ request, sessionId }) {
        const response = await request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "Verify streaming." }],
        });
        if (mock.failure) throw mock.failure;
        NodeAssert.equal(response.stopReason, "end_turn");
        const committed = JSON.parse(await NodeFSP.readFile(file, "utf8"));
        for (const [type, kind, parts] of [
          ["text", "agent_message_chunk", textChunks],
          ["reasoning", "agent_thought_chunk", reasoningChunks],
        ]) {
          const deltas = received
            .filter((u) => u.sessionUpdate === kind)
            .map((u) => u.content.text);
          NodeAssert.deepEqual(deltas, parts);
          NodeAssert.equal(
            deltas.join(""),
            committed
              .filter((b) => b.type === type)
              .map((b) => b.text)
              .join(""),
          );
        }
        NodeAssert.equal(new Set(received.map((u) => u.messageId)).size, 1);
        console.log(
          "2 thought + 3 text chunks acknowledged individually before durable commit; exact committed strings, one message, no duplicates.",
        );
      },
    });
  } finally {
    await mock.close();
  }
});
