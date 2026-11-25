import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import { drive, withWorkspace } from "./drive.mjs";
import { answer, modelId, offlineProfile, startMock } from "./mock-llm.mjs";

const size = 123456;

const framesFor = (trace, sessionId, kind) =>
  trace.filter(
    (m) =>
      m.method === "session/update" &&
      m.params.sessionId === sessionId &&
      m.params.update.sessionUpdate === kind,
  );

async function runSide(cwd, bridgeEnabled) {
  const persistence = NodePath.join(cwd, "logs");
  const mock = await startMock({ textOnly: true, maxTextRequests: bridgeEnabled ? 4 : 5 });
  try {
    const { variables } = await offlineProfile(
      cwd,
      bridgeEnabled,
      mock,
      [
        { id: "session-persistence-jsonl", config: { root: persistence, compression: "none" } },
        {
          id: "compaction-basic",
          config: {
            summarizationProvider: "t3-offline",
            summarizationModel: modelId,
            ...(!bridgeEnabled && { thresholdRatio: 0.1, retainTokens: 1, compactionRetries: 0 }),
          },
        },
      ],
      { contextWindow: size },
    );
    const { result: sessionId, trace } = await drive({
      bridgeEnabled,
      variables,
      cwd,
      profile: "acp",
      async run({ request, sessionId, trace }) {
        const prompt = (text) =>
          request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
        for (const text of ["Remember one", "Remember two"])
          NodeAssert.equal((await prompt(text)).stopReason, "end_turn");

        const usage = framesFor(trace, sessionId, "usage_update");
        for (const frame of usage) console.log(JSON.stringify(frame));
        NodeAssert.deepEqual(
          usage.map((m) => m.params.update.size),
          [size, size],
        );
        const [first, second] = usage.map((m) => m.params.update.used);
        NodeAssert.ok(first > 0 && second > first);
        // The official bridge passes slash text to the model. Trigger its DSH
        // compaction through real context pressure instead.
        const trigger = bridgeEnabled
          ? "/compact"
          : "Describe this sequence: " + "history ".repeat(9000);
        NodeAssert.equal((await prompt(trigger)).stopReason, "end_turn");
        NodeAssert.equal(
          (await prompt(bridgeEnabled ? "/compact" : "Summarize briefly")).stopReason,
          "end_turn",
        );
        return sessionId;
      },
    });
    const files = await NodeFSP.readdir(persistence, { recursive: true });
    const file = files.find((f) => f.endsWith(".jsonl") && f.includes(sessionId));
    NodeAssert.ok(file, `Missing session event log (${files.join(", ")})`);
    const events = (await NodeFSP.readFile(NodePath.join(persistence, file), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const ends = events.filter((e) => e.type === "compaction/end");
    console.log(
      `${bridgeEnabled ? "T3" : "official"} durable compaction/end: ${JSON.stringify(ends.map((e) => e.data))}`,
    );
    NodeAssert.equal(ends.length, bridgeEnabled ? 2 : 1);
    NodeAssert.equal(ends[0].data.error, undefined);

    const framesSeen = framesFor(trace, sessionId, "compaction_update");
    for (const frame of framesSeen) console.log(JSON.stringify(frame));
    if (mock.failure) throw mock.failure;
    if (!bridgeEnabled) {
      NodeAssert.deepEqual(framesSeen, []);
      return;
    }
    NodeAssert.equal(framesSeen[0]?.params.update.compactionId, ends[0].data.compactionId);
    NodeAssert.deepEqual(
      framesSeen.map((m) => m.params.update.status),
      ["in_progress", "completed", "in_progress", "failed"],
    );
    const [start, end, retry, failed] = framesSeen.map((m) => m.params.update);
    NodeAssert.ok(start.compactionId && start.compactionId === end.compactionId);
    const summary = events.find(
      (e) => e.type === "compaction/summary" && e.data.compactionId === end.compactionId,
    );
    NodeAssert.deepEqual(end.summary, summary.data.summary);
    NodeAssert.ok(end.summary.some((b) => b.type === "text" && b.text.includes(answer)));
    NodeAssert.notEqual(retry.compactionId, start.compactionId);
    NodeAssert.equal(retry.compactionId, failed.compactionId);
    NodeAssert.equal(failed.compactionId, ends[1].data.compactionId);
    NodeAssert.match(failed.error, /summary is not smaller/);
    NodeAssert.equal(failed.error, ends[1].data.error);
  } catch (error) {
    throw mock.failure ?? error;
  } finally {
    await mock.close();
  }
}
export async function checkCompaction() {
  for (const bridgeEnabled of [true, false])
    await withWorkspace((cwd) => runSide(cwd, bridgeEnabled));
}
if (import.meta.main) await checkCompaction();
