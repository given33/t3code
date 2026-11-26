import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { AcpSession } from "./session.ts";
import type { Agent, Context, SessionEvent, SessionNotification } from "./host.ts";

vi.mock("./dshRuntime.js", () => ({
  dshRuntime: () => ({
    sdk: {
      RequestError: class RequestError extends Error {
        static invalidParams(_data: undefined, detail: string) {
          return Object.assign(new RequestError(detail), { code: -32602 });
        }
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

function toolCall(callId = "call", args = "{invalid"): SessionEvent<"tool/call"> {
  return { type: "tool/call", data: { name: "plugin-tool", callId, arguments: args } };
}

it.each([
  ["missing presentCall", {}],
  ["undefined presentCall view", { presentCall: () => undefined }],
  [
    "throwing presentCall",
    {
      presentCall: () => {
        throw new Error("plugin failure");
      },
    },
  ],
  ["unknown card", { presentCall: () => ({ card: "future" }) }],
])("falls back to the DSH name and warns once for %s", async (_name, definition) => {
  const get = vi.fn(() => definition);
  const { session, agent, notify, warn } = await setup({ tools: { get } });
  warn.mockClear();
  for (const id of ["a", "b"]) session.onSessionEvent(agent.session, toolCall(id));
  await session.drainUpdates();
  expect(get).toHaveBeenCalledWith("plugin-tool", agent);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls.map(([frame]) => frame)).toEqual(
    ["a", "b"].map((toolCallId) => ({
      sessionId: "test",
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        kind: "other",
        title: "plugin-tool",
        status: "pending",
        rawInput: "{invalid",
      },
    })),
  );
});

it("silently delivers calls and results without ctx.tools", async () => {
  const { session, agent, notify, warn } = await setup();
  warn.mockClear();
  session.onSessionEvent(agent.session, toolCall());
  const content = [{ type: "text" as const, text: "original error" }];
  session.onSessionEvent(agent.session, {
    type: "tool/result",
    data: { message: { toolCallId: "call", content, isError: true } },
  });
  await session.drainUpdates();
  expect(warn).not.toHaveBeenCalled();
  expect(notify.mock.calls.map(([{ update }]) => update)).toEqual([
    {
      sessionUpdate: "tool_call",
      toolCallId: "call",
      kind: "other",
      title: "plugin-tool",
      status: "pending",
      rawInput: "{invalid",
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call",
      status: "failed",
      content: [{ type: "content", content: content[0] }],
    },
  ]);
});

it("uses generic presentation fields and correlates interleaved results with their original args and meta", async () => {
  const blocks = [{ type: "text" as const, text: "description" }];
  const presentResult = vi.fn((args: unknown) => ({ card: "terminal", output: String(args) }));
  const definition = {
    presentCall: () => ({
      card: "generic",
      title: "Search",
      kind: "search",
      rawInput: null,
      locations: [{ path: "dir/file", line: 2 }],
      content: blocks,
    }),
    presentResult,
  };
  const { session, agent, notify } = await setup({ tools: { get: () => definition } });
  for (const id of ["a", "b"])
    session.onSessionEvent(agent.session, toolCall(id, JSON.stringify(id)));
  for (const id of ["b", "a"])
    session.onSessionEvent(agent.session, {
      type: "tool/result",
      data: { meta: id, message: { content: blocks, toolCallId: id } },
    });
  await session.drainUpdates();
  const updates = notify.mock.calls.map(([{ update }]) => update);
  expect(updates[0]).toEqual({
    sessionUpdate: "tool_call",
    toolCallId: "a",
    status: "pending",
    title: "Search",
    kind: "search",
    rawInput: null,
    locations: [{ path: NodePath.resolve("/workspace", "dir/file"), line: 2 }],
    content: [{ type: "content", content: blocks[0] }],
  });
  for (const [index, id] of ["b", "a"].entries()) {
    expect(presentResult).toHaveBeenNthCalledWith(index + 1, id, {
      content: blocks,
      isError: false,
      meta: id,
    });
    expect(updates[index + 2]).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: id } }],
      rawOutput: blocks,
    });
  }
});

it("replaces whole todo snapshots, downgrades unknown statuses and clears only live sessions", async () => {
  const { session, agent, notify, warn } = await setup();
  const write = (content: string, status: string) =>
    session.onSessionEvent(agent.session, {
      type: "todo/write",
      data: { todos: [{ content, status }] },
    });
  const start = () =>
    session.onSessionEvent(agent.session, { type: "turn/start", data: { turn: 2 } });
  warn.mockClear();
  write("first", "completed");
  write("replacement", "unexpected");
  start();
  await session.drainUpdates();
  expect(notify.mock.calls.map(([frame]) => frame)).toEqual(
    [
      [{ content: "first", status: "completed", priority: "medium" }],
      [{ content: "replacement", status: "pending", priority: "medium" }],
      [],
    ].map((entries) => ({ sessionId: "test", update: { sessionUpdate: "plan", entries } })),
  );
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("unknown todo status"));
  write("closing", "pending");
  await session.close("test");
  start();
  await session.drainUpdates();
  expect(notify).toHaveBeenCalledTimes(3);
});

it("keeps the committed result when presentResult throws", async () => {
  const tools = {
    get: () => ({
      presentCall: () => ({ card: "terminal", title: "test command" }),
      presentResult: () => {
        throw new Error("plugin failure");
      },
    }),
  };
  const { session, agent, notify, warn } = await setup({ tools });
  warn.mockClear();
  session.onSessionEvent(agent.session, toolCall());
  const block = { type: "text" as const, text: "durable output" };
  session.onSessionEvent(agent.session, {
    type: "tool/result",
    data: { message: { toolCallId: "call", content: [block] } },
  });
  await session.drainUpdates();
  expect(notify).toHaveBeenLastCalledWith({
    sessionId: "test",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call",
      status: "completed",
      content: [{ type: "content", content: block }],
    },
  });
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("presentResult failed"));
});

it("keeps derived custom out of the target list and orders concurrent successful mode changes", async () => {
  let current = "custom";
  const permissionPresets = {
    names: ["a", "b"],
    current: () => current,
    optionOf: (id: string) => ({
      name: id.toUpperCase(),
      ...(id === "b" && { description: "Second" }),
    }),
    set: vi.fn((_session: unknown, id: string) => {
      current = id;
    }),
  };
  const { session, notify } = await setup({ permissionPresets });
  expect(session.modes()).toEqual({
    currentModeId: "custom",
    availableModes: [
      { id: "a", name: "A" },
      { id: "b", name: "B", description: "Second" },
    ],
  });
  await expect(session.setMode("custom")).rejects.toMatchObject({ code: -32602 });
  expect(permissionPresets.set).not.toHaveBeenCalled();
  await Promise.all([session.setMode("a"), session.setMode("b"), session.setMode("b")]);
  expect(notify.mock.calls.map(([m]) => m.update)).toEqual([
    { sessionUpdate: "current_mode_update", currentModeId: "a" },
    { sessionUpdate: "current_mode_update", currentModeId: "b" },
  ]);
  await session.close("done");
  await expect(session.setMode("a")).rejects.toThrow("session is closing");
});

it("omits mode state and rejects writes when the optional permission service is absent", async () => {
  const { session, notify } = await setup();
  expect(session.modes()).toBeUndefined();
  await expect(session.setMode("workspace-write")).rejects.toMatchObject({ code: -32602 });
  expect(notify).not.toHaveBeenCalled();
});

it("suppresses repeated, stale and closing compaction updates and warns once for pruning", async () => {
  const { session, agent, notify, warn } = await setup();
  const emit = (event: SessionEvent) => session.onSessionEvent(agent.session, event);
  const start = (id: string) => emit({ type: "compaction/start", data: { compactionId: id } });
  const end = (id: string, error?: string) =>
    emit({ type: "compaction/end", data: { compactionId: id, ...(error && { error }) } });
  const summary = (text: string) =>
    emit({
      type: "compaction/summary",
      data: { compactionId: "a", summary: [{ type: "text", text }] },
    });
  emit({ type: "compaction/prune", data: {} });
  emit({ type: "compaction/prune", data: {} });
  start("a");
  start("a");
  end("other");
  summary("retained");
  summary("duplicate");
  end("a");
  end("a", "late failure");
  start("b");
  end("b", "summary failed");
  start("a");
  end("b");
  await session.drainUpdates();
  expect(warn.mock.calls.filter(([s]) => s.includes("compaction/prune"))).toHaveLength(1);
  const frames = notify.mock.calls.map(([{ update }]) => update);
  expect(frames).toEqual([
    { sessionUpdate: "compaction_update", compactionId: "a", status: "in_progress" },
    {
      sessionUpdate: "compaction_update",
      compactionId: "a",
      status: "completed",
      summary: [{ type: "text", text: "retained" }],
    },
    { sessionUpdate: "compaction_update", compactionId: "b", status: "in_progress" },
    {
      sessionUpdate: "compaction_update",
      compactionId: "b",
      status: "failed",
      error: "summary failed",
    },
  ]);
  start("queued");
  const closing = session.close("closing");
  end("queued");
  await closing;
  expect(notify).toHaveBeenCalledTimes(4);
});

it("discards queued assistant and tool updates when the owning prompt is cancelled", async () => {
  const { session, agent, notify } = await setup();
  const claimed = Promise.withResolvers<void>();
  vi.mocked(agent.followup).mockImplementation((message) => {
    session.onInboxClaimed(message, 1);
    claimed.resolve();
  });
  const pending = session.prompt(
    { sessionId: "test", prompt: [{ type: "text", text: "wait" }] },
    false,
  );
  await claimed.promise;
  session.onSessionEvent(agent.session, {
    type: "assistant/message",
    data: { turn: 1, message: { id: "old", content: [{ type: "text", text: "late" }] } },
  });
  session.onSessionEvent(agent.session, toolCall());
  session.cancel();
  session.onSessionEvent(agent.session, {
    type: "tool/result",
    data: { message: { toolCallId: "call", content: [] } },
  });
  await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
  await session.drainUpdates();
  expect(notify).not.toHaveBeenCalled();
});

it("rejects concurrent plain text with invalidParams and warns once when agent.steer is missing", async () => {
  const { session, agent, warn } = await setup();
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  agent.whenIdle = () => {
    waiting.resolve();
    return release.promise;
  };
  const text = { sessionId: "test", prompt: [{ type: "text" as const, text: "message" }] };
  const first = session.prompt(text, false);
  await waiting.promise;
  for (let i = 0; i < 2; i++)
    await expect(session.prompt(text, false)).rejects.toMatchObject({ code: -32602 });
  expect(warn.mock.calls.filter(([msg]) => msg.includes("agent.steer unavailable"))).toHaveLength(
    1,
  );
  expect(agent.followup).toHaveBeenCalledTimes(1);
  release.resolve();
  await expect(first).resolves.toEqual({ stopReason: "end_turn" });
});

it("delivers ordered live thought and text, reconciles a partial block, keeps usage and falls back without a stream", async () => {
  const { session, agent, notify } = await setup({
    tokenMeter: { measure: () => ({ totalTokens: 3 }) },
  });
  agent.session.requestContext = () => ({ contextWindow: 100 });
  const attemptId = "test:1";
  session.onAssistantStream({ type: "start", attemptId, turn: 1, step: 1 });
  const thought = {
    type: "chunk",
    attemptId,
    index: 0,
    chunk: { type: "reasoning-delta", index: 0, text: "why" },
  } as const;
  session.onAssistantStream(thought);
  session.onAssistantStream(thought);
  session.onAssistantStream({
    type: "chunk",
    attemptId,
    index: 1,
    chunk: { type: "block-end", index: 0, block: { type: "reasoning", text: "why" } },
  });
  session.onAssistantStream({
    type: "chunk",
    attemptId,
    index: 2,
    chunk: { type: "text-delta", index: 1, text: "par" },
  });
  await session.drainUpdates();
  const update = () => notify.mock.calls.map(([{ update }]) => update);
  expect(update()).toMatchObject([
    { sessionUpdate: "agent_thought_chunk", content: { text: "why" } },
    { sessionUpdate: "agent_message_chunk", content: { text: "par" } },
  ]);
  session.onSessionEvent(agent.session, {
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      usage: {},
      message: {
        id: "durable",
        content: [
          { type: "reasoning", text: "why" },
          { type: "text", text: "partial" },
        ],
      },
    },
  });
  session.onAssistantStream({ type: "end", attemptId });
  session.onSessionEvent(agent.session, {
    type: "assistant/message",
    data: { turn: 1, step: 2, message: { id: "next", content: [{ type: "text", text: "next" }] } },
  });
  await session.drainUpdates();
  expect(update().slice(2)).toMatchObject([
    { sessionUpdate: "agent_message_chunk", messageId: attemptId, content: { text: "tial" } },
    { sessionUpdate: "usage_update", used: 3, size: 100 },
    { sessionUpdate: "agent_message_chunk", messageId: "next", content: { text: "next" } },
  ]);
});

it("flushes split reasoning breaks before more text and drops the trimmed trailing break", async () => {
  const { session, agent, notify, warn } = await setup();
  warn.mockClear();
  const attemptId = "test:1";
  const deltas = ["first", "\n", "\n", "second", "\n", "\n"];
  const block = { type: "reasoning", text: "first\n\nsecond" } as const;
  session.onAssistantStream({ type: "start", attemptId, turn: 1, step: 1 });
  for (const [index, text] of deltas.entries()) {
    session.onAssistantStream({
      type: "chunk",
      attemptId,
      index,
      chunk: { type: "reasoning-delta", index: 0, text },
    });
  }
  await session.drainUpdates();
  expect(notify.mock.calls.map(([{ update }]) => update)).toMatchObject([
    { sessionUpdate: "agent_thought_chunk", content: { text: "first" } },
    { sessionUpdate: "agent_thought_chunk", content: { text: "\n\nsecond" } },
  ]);
  session.onAssistantStream({
    type: "chunk",
    attemptId,
    index: deltas.length,
    chunk: { type: "block-end", index: 0, block },
  });
  session.onSessionEvent(agent.session, {
    type: "assistant/message",
    data: { turn: 1, step: 1, message: { id: "durable", content: [block] } },
  });
  await session.drainUpdates();
  expect(notify).toHaveBeenCalledTimes(2);
  expect(warn).not.toHaveBeenCalled();
});

it.each([
  { committed: "Hello", warning: "shorter" },
  { committed: "Hello, world!", warning: "differs" },
])(
  "keeps the streamed text, usage and successful turn when the commit is '$committed'",
  async ({ committed, warning }) => {
    const { session, agent, notify, warn } = await setup({
      tokenMeter: { measure: () => ({ totalTokens: 3 }) },
    });
    agent.session.requestContext = () => ({ contextWindow: 100 });
    const attemptId = "test:1";
    const streamed = "Hello world";
    vi.mocked(agent.followup).mockImplementation((message) => {
      session.onInboxClaimed(message, 1);
      session.onAssistantStream({ type: "start", attemptId, turn: 1, step: 1 });
      session.onAssistantStream({
        type: "chunk",
        attemptId,
        index: 0,
        chunk: { type: "text-delta", index: 0, text: streamed },
      });
      session.onSessionEvent(agent.session, {
        type: "assistant/message",
        data: {
          turn: 1,
          step: 1,
          usage: {},
          message: { id: "durable", content: [{ type: "text", text: committed }] },
        },
      });
      session.onSessionEvent(agent.session, {
        type: "turn/end",
        data: { turn: 1, reason: { kind: "completed" } },
      });
    });
    await expect(
      session.prompt({ sessionId: "test", prompt: [{ type: "text", text: "test" }] }, false),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(warning));
    expect(notify.mock.calls.map(([{ update }]) => update)).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: attemptId,
        content: { type: "text", text: streamed },
      },
      { sessionUpdate: "usage_update", used: 3, size: 100 },
    ]);
  },
);
