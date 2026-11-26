// Production CLI, WS command and DSH runtime. Only the Responses model is simulated.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { until, withAuditServer } from "./audit-server.mjs";
import { withWorkspace } from "./drive.mjs";
import { modelId, offlineProfile, startMock } from "./mock-llm.mjs";

const bridgeEnabled = !process.argv.includes("--official");
const expectedAgent = bridgeEnabled ? "t3-deepseek-harness-acp" : "deepseek-harness-acp";
const prompts = ["T22-keep-user", "T22-discard-user", "T22-followup-user"];
const answers = ["T22-keep-answer", "T22-discard-answer", "T22-followup-answer"];
const markers = prompts.flatMap((prompt, i) => [prompt, answers[i]]);
function present(value) {
  const text = JSON.stringify(value);
  return markers.filter((marker) => text.includes(marker));
}
function transcript(projection) {
  return projection.visibleTurnItems.flatMap(({ item }) =>
    item.type === "user_message" || item.type === "assistant_message" ? [item.text] : [],
  );
}
await withWorkspace(async (root) => {
  const traceFile = NodePath.join(root, "trace.jsonl");
  const inputs = [];
  const mock = await startMock({
    textOnly: true,
    textChunks: (i) => [answers[i]],
    onModelInput: (input) => inputs.push(present(input)),
  });
  try {
    const { variables } = await offlineProfile(root, bridgeEnabled, mock);
    await withAuditServer(
      {
        root,
        variables,
        bridgeEnabled,
        witness: new URL("./rewind-witness.mjs", import.meta.url),
        witnessEnv: { T22_TRACE: traceFile },
      },
      async ({ workspace, rpc, cli }) => {
        const providers = await rpc("server.refreshProviders", {
          instanceId: "dsh",
          cwd: workspace,
          fresh: true,
          refreshModels: true,
        });
        const status = (providers.providers ?? providers).find((p) => p.instanceId === "dsh");
        console.log(
          JSON.stringify({
            status: status.status,
            models: status.models.map((m) => m.slug),
            supportsConversationRollback: status.supportsConversationRollback,
          }),
        );
        NodeAssert.equal(status.supportsConversationRollback, true);
        const first = JSON.parse(
          await cli([
            "thread",
            "start",
            workspace,
            prompts[0],
            "--provider",
            "dsh",
            "--model",
            JSON.stringify(["t3-offline", modelId]),
            "--title",
            "T22",
            "--wait",
            "--json",
          ]),
        );
        const { threadId } = first;
        const send = async (i) =>
          JSON.parse(await cli(["thread", "send", threadId, prompts[i], "--wait", "--json"]));
        const projection = () => rpc("orchestration.getThreadProjection", { threadId });
        const native = (p) =>
          p.providerThreads.find((t) => t.id === p.thread.activeProviderThreadId).nativeThreadRef
            .nativeId;
        NodeAssert.ok(present(first).includes(answers[0]));
        NodeAssert.ok(present(await send(1)).includes(answers[1]));
        const before = await projection();
        const checkpoint = before.checkpoints.find(
          (c) => c.appRunOrdinal === 1 && c.status !== "stale",
        );
        NodeAssert.ok(checkpoint, JSON.stringify(before.checkpoints));
        NodeAssert.deepEqual(transcript(before), markers.slice(0, 4));
        const command = {
          type: "checkpoint.rollback",
          commandId: NodeCrypto.randomUUID(),
          threadId,
          scopeId: checkpoint.scopeId,
          checkpointId: checkpoint.id,
          restoreFiles: false,
        };
        console.log(JSON.stringify({ command, nativeId: native(before), modelInput: inputs }));
        console.log(JSON.stringify(await rpc("orchestration.dispatchCommand", command)));
        const after = await until(async () => {
          const p = await projection();
          return p.runs.some((r) => r.status === "rolled_back") && p;
        }, "checkpoint rollback");
        NodeAssert.notEqual(native(before), native(after));
        NodeAssert.deepEqual(transcript(after), markers.slice(0, 2));
        const trace = async () =>
          (await NodeFSP.readFile(traceFile, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const oldPid = (await trace()).find(
          (f) => f.type === "session/new" && f.sessionId === native(before),
        )?.pid;
        NodeAssert.ok(oldPid, "original session/new must identify its ACP process");
        await until(() => {
          try {
            process.kill(oldPid, 0);
            return false;
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
            return true;
          }
        }, "old DSH process exit before follow-up");
        NodeAssert.ok(present(await send(2)).includes(answers[2]));
        if (mock.failure) throw mock.failure;
        const final = await projection();
        console.log(
          JSON.stringify({
            kept: transcript(after),
            modelInputs: inputs,
            afterRollback: native(after),
            afterFollowup: native(final),
          }),
        );
        const frames = await trace();
        const sessions = [native(before), native(after), native(final)].map((id) =>
          frames.find((f) => f.type === "session/new" && f.sessionId === id),
        );
        NodeAssert.ok(
          sessions.every((s) => s?.agent === expectedAgent),
          JSON.stringify(frames),
        );
        const terminals = frames.filter((f) => f.type === "turn.terminal");
        console.log(JSON.stringify({ sessions, exitedPid: oldPid, terminals }));
        NodeAssert.deepEqual(inputs, [
          [prompts[0]],
          markers.slice(0, 3),
          [prompts[0], answers[0], prompts[2]],
        ]);
        NodeAssert.deepEqual(transcript(final), [prompts[0], answers[0], prompts[2], answers[2]]);
        NodeAssert.deepEqual(
          terminals.map((t) => [t.runOrdinal, t.status]),
          [
            [1, "completed"],
            [2, "completed"],
            [3, "completed"],
          ],
        );
        NodeAssert.equal(new Set(terminals.map((t) => t.providerTurnId)).size, 3);
      },
    );
  } finally {
    await mock.close();
  }
});
