// Production WS commands, ACP process identities and requests, with only the Responses API mocked.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { until, withAuditServer } from "./audit-server.mjs";
import { withWorkspace } from "./drive.mjs";
import { modelId, offlineProfile, startMock } from "./mock-llm.mjs";

const marker = `T25-HANDOFF-MARKER-ALPHA-${NodeCrypto.randomUUID()}`;
const model = JSON.stringify(["t3-offline", modelId]);
const generatedTitle = `DSH fallback ${NodeCrypto.randomUUID().slice(0, 8)}`;
const inputs = { main: [], alt: [], title: [] };
const profile = async (root, mock) => (await offlineProfile(root, true, mock)).variables;
const active = (p) => {
  const provider = p.providerThreads.find((t) => t.id === p.thread.activeProviderThreadId);
  NodeAssert.ok(provider?.nativeThreadRef?.nativeId, "Missing active provider/native session");
  return provider;
};
await withWorkspace(async (root) => {
  const tracePath = NodePath.join(root, "trace.jsonl");
  const main = await startMock({
    textOnly: true,
    maxTextRequests: 4,
    textChunks: (i) => [`Main reply ${i + 1}`],
    onModelInput: (input) => inputs.main.push(input),
  });
  const alt = await startMock({
    textOnly: true,
    maxTextRequests: 1,
    textChunks: ["Alternate reply"],
    onModelInput: (input) => inputs.alt.push(input),
  });
  const title = await startMock({
    textOnly: true,
    maxTextRequests: 1,
    expectToolFree: true,
    textChunks: [JSON.stringify({ title: generatedTitle })],
    onModelInput: (input) => inputs.title.push(input),
  });
  try {
    await withAuditServer(
      {
        root,
        variables: await profile(root, main),
        witness: new URL("./rewind-witness.mjs", import.meta.url),
        witnessEnv: { T22_TRACE: tracePath, T25_TRACE_MODES: "1" },
      },
      async ({ cli, rpc, workspace }) => {
        const dispatch = (command) =>
          rpc("orchestration.dispatchCommand", { commandId: NodeCrypto.randomUUID(), ...command });
        const projection = (threadId) => rpc("orchestration.getThreadProjection", { threadId });
        const frames = async () =>
          (await NodeFSP.readFile(tracePath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const refresh = async (instanceId) => {
          const result = await rpc("server.refreshProviders", {
            cwd: workspace,
            fresh: true,
            ...(instanceId && { instanceId, refreshModels: true }),
          });
          return result.providers ?? result;
        };
        const update = (patch) => rpc("server.updateSettings", { patch });
        const send = async (threadId, prompt, answer) => {
          const result = JSON.parse(
            await cli(["thread", "send", threadId, prompt, "--wait", "--json"]),
          );
          const p = await projection(threadId);
          const run = p.runs.find((r) => r.id === result.runId);
          NodeAssert.equal(run?.status, "completed", `Turn ${result.runId} on ${threadId}`);
          NodeAssert.ok(JSON.stringify(result).includes(answer), "Missing model answer");
          return p;
        };
        await update({ defaultRuntimeMode: "approval-required" });
        const snapshot = (await refresh("dsh")).find((p) => p.instanceId === "dsh");
        NodeAssert.ok(snapshot.models.some((m) => m.slug === model));
        const first = JSON.parse(
          await cli([
            "thread",
            "start",
            workspace,
            marker,
            "--provider",
            "dsh",
            "--model",
            model,
            "--title",
            "T25 source",
            "--wait",
            "--json",
          ]),
        );
        const { threadId } = first;
        const source = await projection(threadId);
        NodeAssert.equal(source.thread.runtimeMode, "approval-required");
        NodeAssert.equal(source.runs.find((r) => r.id === first.runId)?.status, "completed");
        NodeAssert.ok(JSON.stringify(first).includes("Main reply 1"));
        const nativeId = active(source).nativeThreadRef.nativeId;
        const session = (await frames()).find(
          (f) => f.type === "session/new" && f.sessionId === nativeId,
        );
        NodeAssert.equal(session?.agent, "t3-deepseek-harness-acp");
        const modeWrites = (records) =>
          records
            .filter((f) => f.type === "session/set_mode" && f.sessionId === nativeId)
            .map((f) => f.modeId);
        const beforeSwitch = (await frames()).length;
        for (const [i, runtimeMode, preset] of [
          [2, "full-access", "danger-full-access"],
          [3, "approval-required", "workspace-write"],
        ]) {
          const before = (await frames()).length;
          await dispatch({ type: "thread.runtime-mode.set", threadId, runtimeMode });
          const p = await send(threadId, `Mode turn ${i}`, `Main reply ${i}`);
          const native = active(p).nativeThreadRef.nativeId;
          const observed = await frames();
          console.log(
            JSON.stringify({
              turn: i,
              runtimeMode,
              originalNative: nativeId,
              native,
              originalPid: session.pid,
              writes: modeWrites(observed.slice(before)),
              sessions: observed.slice(before).filter((f) => f.type === "session/new"),
            }),
          );
          NodeAssert.equal(p.thread.runtimeMode, runtimeMode);
          NodeAssert.equal(native, nativeId, "Switch replaced the native DSH session");
          NodeAssert.deepEqual(modeWrites(observed.slice(before)), [preset]);
          process.kill(session.pid, 0);
        }
        const afterSwitch = await frames();
        NodeAssert.deepEqual(
          afterSwitch
            .filter((f) => f.type === "session/prompt" && f.sessionId === nativeId)
            .map((f) => f.pid),
          [session.pid, session.pid, session.pid],
        );
        NodeAssert.deepEqual(
          afterSwitch.slice(beforeSwitch).filter((f) => f.type === "session/new"),
          [],
        );
        NodeAssert.equal(
          afterSwitch.filter((f) => f.type === "session/new" && f.sessionId === nativeId).length,
          1,
        );
        NodeAssert.deepEqual(
          afterSwitch
            .filter((f) => f.type === "turn.terminal")
            .map((f) => [f.runOrdinal, f.status]),
          [
            [1, "completed"],
            [2, "completed"],
            [3, "completed"],
          ],
        );
        const forkId = NodeCrypto.randomUUID();
        await dispatch({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          sourceThreadId: threadId,
          targetThreadId: forkId,
          sourcePoint: { type: "latest_stable" },
          title: "T25 fork",
        });
        const fork = await send(forkId, "Continue on the fork", "Main reply 4");
        const forkNative = active(fork).nativeThreadRef.nativeId;
        NodeAssert.equal(fork.thread.forkedFrom?.threadId, threadId);
        NodeAssert.notEqual(forkNative, nativeId);
        NodeAssert.ok(
          (await frames()).some((f) => f.type === "session/new" && f.sessionId === forkNative),
        );
        NodeAssert.equal(inputs.main.length, 4);
        NodeAssert.ok(
          JSON.stringify(inputs.main[3]).includes(marker),
          "Fork model input lost source marker",
        );
        console.log(JSON.stringify({ forkId, forkNative, source: threadId, markerInFork: true }));

        const config = (await rpc("server.getSettings", {})).providerInstances.dsh;
        const altInstance = {
          ...config,
          environment: await profile(NodePath.join(root, "alt"), alt),
        };
        await rpc("server.updateSettings", {
          patch: {},
          providerInstanceMutation: {
            operation: "create",
            instanceId: "dsh-alt",
            instance: altInstance,
          },
        });
        NodeAssert.ok(
          (await refresh("dsh-alt")).some(
            (p) => p.instanceId === "dsh-alt" && p.models.some((m) => m.slug === model),
          ),
        );
        await dispatch({
          type: "thread.model-selection.set",
          threadId,
          modelSelection: { instanceId: "dsh-alt", model },
        });
        const switched = await send(
          threadId,
          "Continue with the other instance",
          "Alternate reply",
        );
        const target = active(switched);
        NodeAssert.equal(target.providerInstanceId, "dsh-alt");
        NodeAssert.notEqual(target.nativeThreadRef.nativeId, nativeId);
        const handoff = switched.contextHandoffs.find(
          (h) => h.toProviderThreadId === target.id && h.status === "ready",
        );
        // The WS projection deliberately strips summaryText. Link its metadata to the run,
        // then verify the actual delivered content at the distinct alternate model endpoint.
        NodeAssert.ok(handoff?.fromProviderThreadIds.includes(active(source).id));
        NodeAssert.equal(
          switched.runs.find((r) => r.id === handoff.targetRunId)?.contextHandoffId,
          handoff.id,
        );
        NodeAssert.equal(inputs.alt.length, 1);
        NodeAssert.ok(
          inputs.alt[0].some((item) => JSON.stringify(item).includes(marker)),
          "Alternate model input lost handoff marker",
        );
        console.log(
          JSON.stringify({
            threadId,
            instance: target.providerInstanceId,
            strategy: handoff.strategy,
            markerInHandoff: true,
          }),
        );

        const providers = await refresh();
        const providerInstances = Object.fromEntries(
          providers.map((p) => [
            p.instanceId,
            { driver: p.driver, enabled: false, config: { enabled: false } },
          ]),
        );
        providerInstances.dsh = {
          ...config,
          environment: await profile(NodePath.join(root, "title"), title),
        };
        const settings = await update({ providerInstances });
        NodeAssert.deepEqual(settings.textGenerationModelSelection, {
          instanceId: "dsh",
          model: "default",
        });
        await refresh("dsh");
        NodeAssert.deepEqual(
          (await refresh()).filter((p) => p.enabled).map((p) => p.instanceId),
          ["dsh"],
        );
        const beforeTitle = (await frames()).length;
        await dispatch({ type: "thread.metadata.update", threadId, regenerateTitle: true });
        await until(
          async () => (await projection(threadId)).thread.title === generatedTitle,
          "model-generated title",
        );
        NodeAssert.equal(inputs.title.length, 1);
        NodeAssert.ok(JSON.stringify(inputs.title[0]).includes(marker));
        const titleFrames = (await frames()).slice(beforeTitle);
        const titlePrompts = titleFrames.filter(
          (f) => f.type === "session/prompt" && f.client === "t3-dsh-text",
        );
        NodeAssert.equal(titlePrompts.length, 1);
        const titleSession = titlePrompts[0].sessionId;
        NodeAssert.ok(
          ![nativeId, forkNative, target.nativeThreadRef.nativeId].includes(titleSession),
        );
        NodeAssert.ok(
          titleFrames.some(
            (f) =>
              f.type === "session/new" &&
              f.sessionId === titleSession &&
              f.agent === "t3-deepseek-harness-acp",
          ),
        );
        console.log(
          JSON.stringify({
            fallback: settings.textGenerationModelSelection,
            title: generatedTitle,
            tools: 0,
          }),
        );
      },
    );
    for (const mock of [main, alt, title]) if (mock.failure) throw mock.failure;
  } finally {
    await Promise.all([main.close(), alt.close(), title.close()]);
  }
});
