import * as NodeAssert from "node:assert/strict";
import { drive, normalize, withWorkspace } from "./drive.mjs";

const results = [];
for (const bridgeEnabled of [false, true]) {
  await withWorkspace(async (cwd) => {
    const { trace, result } = await drive({
      bridgeEnabled,
      cwd,
      async run({ request, sessionId, configOptions, trace, label }) {
        const models = configOptions.find((o) => o.id === "model");
        for (const provider of ["deepseek-official", "deepseek-account"]) {
          const group = models.options.find((g) => g.group === provider);
          NodeAssert.ok(group, `Missing ${provider}`);
          console.log(`${label} ${provider} models=${group.options.length}`);
        }
        const pixel = models.options.find((g) => g.group === "pixel")?.options[0];
        const route = process.env.T3_DSH_PARITY_MODEL || pixel?.value || models.currentValue;
        console.log(`${label} live route=${route}`);
        await request("session/set_config_option", { sessionId, configId: "model", value: route });
        try {
          const response = await request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "一加一等于几？只回答一个数字，不使用工具。" }],
          });
          NodeAssert.equal(response.stopReason, "end_turn");
          const answer = trace
            .filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk")
            .map((m) => m.params.update.content.text)
            .join("")
            .trim();
          NodeAssert.ok(answer, "Missing assistant text");
          console.log(
            `${label} session/prompt=end_turn, answer=${answer === "2" ? "2" : `(${answer.length} characters)`}`,
          );
          return "ok";
        } catch (e) {
          if (!e.providerUnavailable) throw e;
          console.log(`${label} real text unverified: ${e.message}`);
          return e.message;
        }
      },
    });
    results.push({ trace: normalize(trace, cwd), result });
  });
}
NodeAssert.deepEqual(results[0].trace, results[1].trace, "Live JSON-RPC parity differs");
console.log(
  results[0].result === "ok"
    ? "Parity OK (agentInfo only)."
    : `Lifecycle and provider-error parity OK; live text unverified: ${results[0].result}`,
);
