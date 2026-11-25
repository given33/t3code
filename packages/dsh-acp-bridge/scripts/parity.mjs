import * as NodeAssert from "node:assert/strict";
import { drive, normalize, withWorkspace } from "./drive.mjs";

const routeOverride = process.env.T3_DSH_PARITY_MODEL;

async function runSide(bridgeEnabled, cwd) {
  const { trace } = await drive({
    bridgeEnabled,
    cwd,
    async run({ request, sessionId, configOptions, trace, label }) {
      const models = configOptions.find((o) => o.id === "model");
      NodeAssert.ok(models, "Missing model config option");
      for (const provider of ["deepseek-official", "deepseek-account"]) {
        const group = models.options.find((g) => g.group === provider);
        NodeAssert.ok(group, `Missing ${provider}`);
        console.log(`${label} ${provider} models=${group.options.length}`);
      }
      const pixel = models.options.find((g) => g.group === "pixel")?.options[0];
      const route = routeOverride || pixel?.value || models.currentValue;
      if (!route)
        throw new Error("No live route selected. Set T3_DSH_PARITY_MODEL to a model option.");
      console.log(`${label} live route=${route}`);
      await request("session/set_config_option", { sessionId, configId: "model", value: route });
      const start = trace.length;
      const response = await request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "一加一等于几？只回答一个数字，不使用工具。" }],
      });
      if (!response?.stopReason) throw new Error("session/prompt returned no stopReason");
      NodeAssert.equal(
        response.stopReason,
        "end_turn",
        `session/prompt stopReason=${response.stopReason}, expected end_turn`,
      );
      const updates = trace.slice(start).filter((m) => m.method === "session/update");
      const answer = updates
        .map((m) => m.params.update)
        .filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text")
        .map((u) => u.content.text)
        .filter((text) => typeof text === "string")
        .join("")
        .trim();
      if (!answer) throw new Error("session/prompt returned no non-empty agent_message_chunk text");
      console.log(
        `${label} session/prompt=${response.stopReason}, answer=${answer === "2" ? "2" : `(${answer.length} characters)`}`,
      );
    },
  });
  return normalize(trace, cwd, { liveUsage: true });
}

async function main() {
  if (routeOverride === "skip") {
    console.log("SKIP: no live route selected (T3_DSH_PARITY_MODEL=skip).");
    return;
  }
  const traces = [];
  for (const bridgeEnabled of [false, true]) {
    const label = bridgeEnabled ? "T3" : "official";
    try {
      traces.push(await withWorkspace((cwd) => runSide(bridgeEnabled, cwd)));
    } catch (error) {
      const category = error.code === "ERR_ASSERTION" ? "Behavior mismatch" : "Live call failed";
      console.error(`${label} ${category}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (traces.length !== 2) return;
  NodeAssert.deepEqual(traces[1], traces[0], "Behavior mismatch: live JSON-RPC traces differ");
  const sizes = traces[0]
    .filter(
      (m) => m.method === "session/update" && m.params.update.sessionUpdate === "usage_update",
    )
    .map((m) => m.params.update.size);
  NodeAssert.ok(
    sizes.length > 0 && sizes.every((size) => Number.isSafeInteger(size) && size > 0),
    "Behavior mismatch: missing or invalid usage.size",
  );
  const sequence = traces[0].map((m) => {
    if (m.request) return `>${m.request}`;
    if (m.reply) return `<${m.reply}`;
    if (m.params) return `${m.method}/${m.params.update?.sessionUpdate ?? "request"}`;
    return `<${m.method}`;
  });
  console.log(
    `Parity OK: identical ordered messages (${sequence.length}), usage.size=${sizes.join(",")}`,
  );
  console.log(sequence.join(" "));
}

await main();
