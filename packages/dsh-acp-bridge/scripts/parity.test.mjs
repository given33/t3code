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

it("only accounts for one T3 advertisement per successful activation of the same session", () => {
  const init = { method: "initialize", result: { agentInfo: {} } };
  const notification = {
    method: "session/update",
    params: {
      sessionId: "session",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "compact", description: "Compact" }],
      },
    },
  };
  const create = { request: "session/new" },
    created = { method: "session/new", result: { sessionId: "session" } };
  const resume = { request: "session/resume" },
    resumed = { method: "session/resume", result: {} };
  const official = [init, create, created, resume, resumed];
  const t3 = [init, create, notification, created, resume, notification, resumed];
  const normalizeT3 = (trace) => normalize(trace, process.cwd(), { t3Advertisements: true });
  expect(normalizeT3(t3)).toEqual(normalize(official, process.cwd()));
  expect(normalize(t3, process.cwd())).not.toEqual(normalizeT3(t3));
  expect(() => normalizeT3(official)).toThrow("Missing T3");
  expect(() => normalizeT3([...t3, notification])).toThrow("Unexpected extra");
  expect(() =>
    normalizeT3(
      t3.with(2, { ...notification, params: { ...notification.params, sessionId: "other" } }),
    ),
  ).toThrow();
});
