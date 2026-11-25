import { expect, it } from "vitest";
import { normalize } from "./drive.mjs";

it("compares live usage capacity and the wire contract while ignoring token counts", () => {
  const trace = (count) => [
    { method: "initialize", result: { agentInfo: {} } },
    {
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", size: 1_000_000, used: count } },
    },
    {
      method: "session/prompt",
      result: { stopReason: "end_turn", usage: { inputTokens: count, outputTokens: 1 } },
    },
    {
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call", rawInput: { usage: { used: 10 } } } },
    },
  ];
  const live = (messages) => normalize(messages, process.cwd(), { liveUsage: true });
  const official = trace(6650);
  const t3 = trace(6630);
  expect(live(t3)).toEqual(live(official));
  expect(normalize(t3, process.cwd())).not.toEqual(normalize(official, process.cwd()));
  expect(live(t3)[1].params.update.size).toBe(1_000_000);
  expect(live(t3)[3].params.update.rawInput.usage.used).toBe(10);
  delete t3[2].result.usage.outputTokens;
  expect(live(t3)).not.toEqual(live(official));
});
