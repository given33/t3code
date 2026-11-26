import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { drive, withWorkspace } from "./drive.mjs";
import { answer, fileName, fixture, offlineProfile, startMock, toolArgs } from "./mock-llm.mjs";

const steer = "Use the next step to verify the fixture.";
await withWorkspace(async (cwd) => {
  const streaming = Promise.withResolvers();
  const release = Promise.withResolvers();
  const inputs = [];
  const responses = [];
  const mock = await startMock({
    onModelInput(input) {
      inputs.push(input);
    },
    async onToolStart() {
      streaming.resolve();
      await release.promise;
    },
  });
  try {
    await NodeFSP.writeFile(NodePath.join(cwd, fileName), fixture);
    const { variables } = await offlineProfile(cwd, true, mock);
    await drive({
      bridgeEnabled: true,
      variables,
      cwd,
      allowPermission: (call) => call?.rawInput?.command === toolArgs.command,
      onResponse(method, frame) {
        if (method === "session/prompt") {
          responses.push(frame);
          console.log(JSON.stringify(frame));
        }
      },
      async run({ request, sessionId, trace }) {
        const send = (text) =>
          request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
        const first = send("Read the test fixture.");
        await Promise.race([
          streaming.promise,
          first.then(() => NodeAssert.fail("first prompt settled before tool stream")),
        ]);
        const next = send(steer);
        try {
          await Promise.race([
            first,
            next.then(() => NodeAssert.fail("steer settled before the tool finished")),
          ]);
          NodeAssert.deepEqual(await first, { stopReason: "end_turn" });
          NodeAssert.equal(responses.length, 1);
        } finally {
          release.resolve();
        }
        NodeAssert.deepEqual(await next, { stopReason: "end_turn" });
        NodeAssert.equal(responses.length, 2);
        NodeAssert.ok(responses[0].id < responses[1].id);
        NodeAssert.equal(inputs.length, 2);
        NodeAssert.ok(!inputs[0].some((m) => JSON.stringify(m).includes(steer)));
        const nextInput = inputs[1].filter(
          (m) => m.role === "user" || m.type === "function_call_output",
        );
        console.log("step 2", JSON.stringify(nextInput));
        NodeAssert.ok(
          nextInput.some((m) => m.role === "user" && JSON.stringify(m.content).includes(steer)),
        );
        NodeAssert.ok(
          nextInput.some(
            (m) => m.type === "function_call_output" && JSON.stringify(m.output).includes(fixture),
          ),
        );
        const updates = trace.filter(
          (m) =>
            m.method === "session/update" &&
            m.params.update.sessionUpdate !== "available_commands_update",
        );
        for (const frame of updates) console.log(JSON.stringify(frame));
        const byKind = (kind) =>
          updates.map((m) => m.params.update).filter((u) => u.sessionUpdate === kind);
        NodeAssert.equal(byKind("tool_call").length, 1);
        NodeAssert.deepEqual(
          byKind("tool_call_update").map((u) => [u.toolCallId, u.status]),
          [[byKind("tool_call")[0].toolCallId, "completed"]],
        );
        NodeAssert.equal(
          byKind("agent_message_chunk")
            .map((u) => u.content.text)
            .join(""),
          answer,
        );
        NodeAssert.equal(byKind("plan").length, 1, "one native turn/start");
      },
    });
    if (mock.failure) throw mock.failure;
  } finally {
    release.resolve();
    await mock.close();
  }
});

// turn.terminal is a T3 adapter event, so also exercise the production driver.
await withWorkspace(async (cwd) => {
  const streaming = Promise.withResolvers();
  const release = Promise.withResolvers();
  const mock = await startMock({
    textOnly: true,
    onTextStart: async ({ step }) => {
      if (!step) {
        streaming.resolve();
        await release.promise;
      }
    },
  });
  try {
    const { variables } = await offlineProfile(cwd, true, mock);
    const { checkSteerSettlement } =
      await import("../../provider-dsh/scripts/steer-settlement.mjs");
    await checkSteerSettlement({ cwd, variables, streaming, release, steer });
    if (mock.failure) throw mock.failure;
  } finally {
    release.resolve();
    await mock.close();
  }
});
