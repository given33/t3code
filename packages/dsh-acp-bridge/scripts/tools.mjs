import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { drive, withWorkspace } from "./drive.mjs";
import { fileName, fixture, offlineProfile, startMock, toolArgs } from "./mock-llm.mjs";

await withWorkspace(async (root) => {
  const cwd = NodePath.join(root, "workspace");
  await NodeFSP.mkdir(cwd);
  await NodeFSP.writeFile(NodePath.join(cwd, fileName), fixture);
  const todos = [
    { content: "Create fixture", status: "completed" },
    { content: "Inspect fixture", status: "in_progress" },
    { content: "Write report", status: "pending" },
  ];
  const write = { file_path: "report.txt", content: "Projection verified\n" };
  const read = { file_path: fileName };
  const toolCalls = [
    { name: "todo_write", args: { todos } },
    { name: "pwsh", args: toolArgs },
    { name: "read", args: read },
    { name: "write", args: write },
  ];
  const mock = await startMock({ toolCalls });
  try {
    const { variables } = await offlineProfile(root, true, mock);
    const { trace } = await drive({
      bridgeEnabled: true,
      cwd,
      variables,
      profile: "acp",
      allowPermission: (call) =>
        call?.rawInput?.command === toolArgs.command ||
        (call?.kind === "edit" &&
          call.rawInput?.file_path === write.file_path &&
          call.rawInput?.content === write.content) ||
        (call?.kind === "read" && call.rawInput?.file_path === read.file_path),
      async run({ request, sessionId, trace }) {
        const response = await request("session/prompt", {
          sessionId,
          prompt: [
            {
              type: "text",
              text: "Update the checklist, inspect the fixture and write the report.",
            },
          ],
        });
        NodeAssert.equal(response.stopReason, "end_turn");
        const frames = (type) =>
          trace.filter(
            (m) =>
              m.method === "session/update" &&
              m.params.sessionId === sessionId &&
              m.params.update.sessionUpdate === type,
          );
        const print = (frame) => console.log(JSON.stringify(frame).slice(0, 1000));
        const plans = frames("plan");
        NodeAssert.deepEqual(
          plans.map((m) => m.params.update.entries),
          [[], todos.map((todo) => ({ ...todo, priority: "medium" }))],
        );
        print(plans[1]);
        const calls = frames("tool_call");
        const results = frames("tool_call_update");
        NodeAssert.equal(calls.length, toolCalls.length);
        NodeAssert.deepEqual(
          results.map((m) => [m.params.update.toolCallId, m.params.update.status]),
          calls.map((m) => [m.params.update.toolCallId, "completed"]),
        );
        NodeAssert.deepEqual(
          calls.map((m) => m.params.update.status),
          Array(4).fill("pending"),
        );
        const [todoCall, terminal, reader, writer] = calls.map((m) => m.params.update);
        NodeAssert.deepEqual(todoCall.rawInput, todos);
        NodeAssert.equal(terminal.kind, "execute");
        NodeAssert.equal(terminal.title, toolArgs.command);
        NodeAssert.deepEqual(terminal.rawInput, toolArgs);
        NodeAssert.equal(results[1].params.update.content[0].content.text.trim(), fixture);
        print(calls[1]);
        print(results[1]);
        NodeAssert.equal(reader.kind, "read");
        NodeAssert.equal(reader.locations[0].path, NodePath.join(cwd, fileName));
        NodeAssert.ok(
          results[2].params.update.content.some((c) => c.content?.text?.includes(fixture)),
        );
        print(calls[2]);
        NodeAssert.equal(writer.kind, "edit");
        NodeAssert.equal(writer.title, write.file_path);
        const writtenPath = NodePath.join(cwd, write.file_path);
        NodeAssert.deepEqual(writer.locations, [{ path: writtenPath }]);
        NodeAssert.deepEqual(writer.content, [
          { type: "diff", path: writtenPath, oldText: null, newText: write.content },
        ]);
        NodeAssert.equal(results[3].params.update.content[0].newText, write.content);
        NodeAssert.equal(
          await NodeFSP.readFile(NodePath.join(cwd, write.file_path), "utf8"),
          write.content,
        );
        print(calls[3]);
      },
    });
    if (mock.failure) throw mock.failure;
    NodeAssert.deepEqual(mock.seen.get("Bearer offline-t3"), [
      "tool",
      "tool",
      "tool",
      "tool",
      "text",
    ]);
    NodeAssert.ok(!trace.some((m) => m.error));
    console.log("Tool projections OK; close, resume and close succeeded without protocol errors.");
  } catch (error) {
    throw mock.failure ?? error;
  } finally {
    await mock.close();
  }
});
