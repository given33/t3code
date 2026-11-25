import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  answer,
  fileName,
  fixture,
  modelId,
  offlineProfile,
  startMock,
  toolArgs,
} from "./mock-llm.mjs";
import { drive, normalize, withWorkspace } from "./drive.mjs";

async function runOfflineParity(root) {
  const mock = await startMock();
  try {
    const cwd = NodePath.join(root, "workspace");
    await NodeFSP.mkdir(cwd);
    await NodeFSP.writeFile(NodePath.join(cwd, fileName), fixture);
    const runs = await Promise.allSettled(
      [false, true].map(async (bridgeEnabled) => {
        const { variables, route } = await offlineProfile(root, bridgeEnabled, mock);
        const { trace } = await drive({
          bridgeEnabled,
          cwd,
          variables,
          profile: "acp",
          allowPermission: (call) =>
            call?.title === (bridgeEnabled ? toolArgs.command : "pwsh") &&
            call.rawInput?.command === toolArgs.command,
          async run({ request, configOptions, sessionId, trace, label }) {
            NodeAssert.equal(
              configOptions.find((o) => o.id === "model")?.currentValue,
              JSON.stringify([route.provider, modelId]),
            );
            const reply = await request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: "Read the test fixture, then respond." }],
            });
            NodeAssert.equal(reply.stopReason, "end_turn");
            const updates = trace.flatMap((m) =>
              m.method === "session/update" ? [m.params.update] : [],
            );
            const calls = updates.filter((u) => u.sessionUpdate === "tool_call");
            NodeAssert.equal(calls.length, 1);
            NodeAssert.equal(calls[0].title, bridgeEnabled ? toolArgs.command : "pwsh");
            NodeAssert.equal(calls[0].kind, bridgeEnabled ? "execute" : "other");
            NodeAssert.deepEqual(calls[0].rawInput, toolArgs);
            const completed = updates.filter((u) => u.sessionUpdate === "tool_call_update");
            NodeAssert.equal(completed.length, 1);
            NodeAssert.equal(completed[0].toolCallId, calls[0].toolCallId);
            NodeAssert.equal(completed[0].status, "completed");
            NodeAssert.ok(JSON.stringify(completed[0].content).includes(fixture));
            const text = updates
              .filter((u) => u.sessionUpdate === "agent_message_chunk")
              .map((u) => u.content.text)
              .join("");
            NodeAssert.equal(text, answer);
            console.log(
              `${label} agent_message_chunk=${JSON.stringify(text)} tool_call=pwsh kind=${calls[0].kind} status=${calls[0].status} tool_call_update=completed`,
            );
          },
        });
        return normalize(trace, cwd, {
          t3Advertisements: bridgeEnabled,
          t3Modes: bridgeEnabled,
          t3TurnReset: bridgeEnabled,
          pwshCommand: bridgeEnabled ? toolArgs.command : undefined,
        });
      }),
    );
    if (mock.failure) throw mock.failure;
    const traces = runs.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    for (const requests of mock.seen.values()) NodeAssert.deepEqual(requests, ["tool", "text"]);
    NodeAssert.deepEqual(traces[0], traces[1]);
    console.log(
      "Offline parity OK: identical ordered messages, streamed text, tool input/output and close (accounted for agentInfo, setup advertisements and permission modes, turn/start plan reset and pwsh presentation).",
    );
  } catch (e) {
    throw mock.failure ?? e;
  } finally {
    await mock.close();
  }
}

export const checkOfflineParity = () => withWorkspace(runOfflineParity);

if (import.meta.main) await checkOfflineParity();
