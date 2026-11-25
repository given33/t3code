import { expect, it, vi } from "vite-plus/test";
import { AcpSession } from "./session.ts";
import type { Agent, Context } from "./host.ts";

vi.mock("./dshRuntime.js", () => ({
  dshRuntime: () => ({
    agent: { installModelSelection: vi.fn() },
    llm: {
      createUserMessage: (input: object) => ({ ...input, id: "message" }),
      errorChain: String,
    },
  }),
}));

it("settles prompts and flushes/disposes once when optional subagent methods are absent", async () => {
  const warn = vi.fn();
  const flush = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const agent: Agent = {
    id: "root",
    status: "idle",
    session: {
      id: "test",
      seq: 1,
      header: { id: "test", createdAt: 1 },
      requestContext: () => undefined,
    },
    model: { current: () => undefined, select: vi.fn() },
    cancel: vi.fn(),
    whenIdle: async () => {},
    followup: (message) => {
      session.onInboxClaimed(message, 1);
      session.onSessionEvent(agent.session, {
        type: "turn/end",
        data: { turn: 1, reason: { kind: "completed" } },
      });
    },
  };
  const ctx = {
    get: (key: string) => (key === "subagents" ? {} : undefined),
    logger: { warn },
    sessions: { flush },
    agents: {
      get: () => agent,
      create: async ({ setup }: { setup(ctx: Context): Promise<void> }) => {
        await setup(ctx as unknown as Context);
        return { agent, dispose };
      },
    },
  };
  const session = await AcpSession.create(ctx as unknown as Context, {
    sessionId: "test",
    cwd: "/workspace",
    agentOptions: {},
    mcpServers: [],
    signal: new AbortController().signal,
    notify: async () => {},
  });
  await expect(
    session.prompt({ sessionId: "test", prompt: [{ type: "text", text: "test" }] }, false),
  ).resolves.toEqual({ stopReason: "end_turn" });
  await Promise.all([session.close("close"), session.close("close again")]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("waitForTreeWork unavailable"));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("drainDescendants unavailable"));
  expect(flush).toHaveBeenCalledExactlyOnceWith(agent.session);
  expect(dispose).toHaveBeenCalledTimes(1);
});
