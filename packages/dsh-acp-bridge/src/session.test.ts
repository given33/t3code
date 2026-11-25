import { expect, it, vi } from "vite-plus/test";
import { AcpSession } from "./session.ts";
import type { Agent, Context, SessionNotification } from "./host.ts";

vi.mock("./dshRuntime.js", () => ({
  dshRuntime: () => ({
    sdk: {
      RequestError: class RequestError extends Error {
        static internalError(_data: undefined, detail: string) {
          return Object.assign(new RequestError(detail), { code: -32603 });
        }
      },
    },
    agent: { installModelSelection: vi.fn() },
    llm: {
      createUserMessage: (input: object) => ({ ...input, id: "message" }),
      errorChain: String,
    },
  }),
}));

async function setup(services: Record<string, unknown> = {}) {
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
    followup: vi.fn((message) => {
      session.onInboxClaimed(message, 1);
      session.onSessionEvent(agent.session, {
        type: "turn/end",
        data: { turn: 1, reason: { kind: "completed" } },
      });
    }),
  };
  const ctx = {
    get: (key: string) => (key === "subagents" ? {} : services[key]),
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
  const notify = vi.fn(async (_notification: SessionNotification) => {});
  const session = await AcpSession.create(ctx as unknown as Context, {
    sessionId: "test",
    cwd: "/workspace",
    agentOptions: {},
    mcpServers: [],
    signal: new AbortController().signal,
    notify,
  });
  return { session, warn, flush, dispose, agent, notify };
}

it("settles prompts and flushes/disposes once when optional subagent methods are absent", async () => {
  const { session, agent, warn, flush, dispose } = await setup();
  await expect(
    session.prompt({ sessionId: "test", prompt: [{ type: "text", text: "test" }] }, false),
  ).resolves.toEqual({ stopReason: "end_turn" });
  await Promise.all([session.close("close"), session.close("close again")]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("waitForTreeWork unavailable"));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("drainDescendants unavailable"));
  expect(flush).toHaveBeenCalledExactlyOnceWith(agent.session);
  expect(dispose).toHaveBeenCalledTimes(1);
});

const command = { sessionId: "test", prompt: [{ type: "text" as const, text: "/test" }] };

it("cancels a running command with its request signal and accepts the next prompt", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const execute = async (_agent: Agent, _line: string, _attachments: [], signal: AbortSignal) => {
    started.resolve(signal);
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    signal.throwIfAborted();
  };
  const { session, agent, notify } = await setup({ commands: { execute } });
  const pending = session.prompt(command, false);
  const signal = await started.promise;
  session.cancel();
  expect(signal.aborted).toBe(true);
  await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
  expect(notify).not.toHaveBeenCalled();
  expect(agent.followup).not.toHaveBeenCalled();
  await expect(
    session.prompt({ sessionId: "test", prompt: [{ type: "text", text: "next" }] }, false),
  ).resolves.toEqual({ stopReason: "end_turn" });
});

it("reports a registry exception as ACP internalError without scheduling a model turn", async () => {
  const { session, agent, notify } = await setup({
    commands: {
      execute: async () => {
        throw new Error("registry failure");
      },
    },
  });
  await expect(session.prompt(command, false)).rejects.toMatchObject({
    code: -32603,
    message: expect.stringContaining("registry failure"),
  });
  expect(agent.followup).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

it("warns on missing registries and publishes an authoritative empty update only for installed registries", async () => {
  const services: Record<string, unknown> = {};
  const { session, warn, notify } = await setup(services);
  await session.advertiseCommands();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("commands registry unavailable"));
  services.commands = { list: () => [] };
  await session.advertiseCommands();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("skills registry unavailable"));
  expect(notify).not.toHaveBeenCalled();
  services.skills = { list: async () => [] };
  await session.advertiseCommands();
  expect(notify).toHaveBeenCalledExactlyOnceWith({
    sessionId: "test",
    update: { sessionUpdate: "available_commands_update", availableCommands: [] },
  });
});

it("keeps command and skill namespaces separate when names collide", async () => {
  const execute = vi.fn(async () => ({
    commandId: "invocation",
    result: { kind: "error", text: "DSH usage" },
  }));
  const same = { name: "test", description: "Test" };
  const { session, agent, notify } = await setup({
    commands: { list: () => [same], execute },
    skills: { list: async () => [same] },
  });
  await session.advertiseCommands();
  expect(notify.mock.calls[0]?.[0].update).toEqual({
    sessionUpdate: "available_commands_update",
    availableCommands: [{ ...same, name: "$test" }, same],
  });
  await expect(
    session.prompt({ sessionId: "test", prompt: [{ type: "text", text: "$test $other" }] }, false),
  ).resolves.toEqual({ stopReason: "end_turn" });
  expect(execute).not.toHaveBeenCalled();
  expect(agent.followup).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ content: [{ type: "text", text: "/test $other" }] }),
  );
  await expect(session.prompt(command, false)).resolves.toEqual({ stopReason: "end_turn" });
  expect(execute).toHaveBeenCalledExactlyOnceWith(agent, "/test", [], expect.any(AbortSignal));
  expect(notify).toHaveBeenLastCalledWith({
    sessionId: "test",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "invocation",
      content: { type: "text", text: "DSH usage" },
    },
  });
  expect(agent.followup).toHaveBeenCalledTimes(1);
});
