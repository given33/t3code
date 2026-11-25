import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { makeProviderFailure } from "../../provider-core/src/server/failure.ts";
import { withDshLaunch } from "../../provider-dsh/scripts/parity-launch.mjs";

export async function withWorkspace(run) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dsh-e2e-"));
  try {
    return await run(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function drive({
  bridgeEnabled,
  cwd,
  variables = [],
  extraPatch,
  syncLocalModels,
  profile,
  allowPermission,
  run,
}) {
  const label = bridgeEnabled ? "T3" : "official";
  return withDshLaunch(
    { bridgeEnabled, variables, extraPatch, syncLocalModels, profile },
    async ({ command, args, env, platform }) => {
      const child = NodeChildProcess.spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        detached: platform !== "win32",
      });
      const closed = new Promise((done) => child.once("close", done));
      const reader = NodeReadline.createInterface({ input: child.stdout });
      child.stderr.resume();
      const trace = [];
      let pending,
        failure,
        nextId = 0;
      const fail = (error) => {
        failure ??= error;
        pending?.reject(error);
      };
      child.once("error", fail);
      child.once("exit", (code, signal) => fail(new Error(`DSH exited (${code ?? signal})`)));
      child.stdin.on("error", fail);
      reader.on("line", (line) => {
        try {
          const msg = JSON.parse(line);
          NodeAssert.equal(msg.jsonrpc, "2.0");
          if (msg.method) {
            trace.push(msg);
            if (msg.id !== undefined) {
              NodeAssert.equal(msg.method, "session/request_permission");
              const call = trace.findLast(
                (m) =>
                  m.params?.update?.sessionUpdate === "tool_call" &&
                  m.params.update.toolCallId === msg.params.toolCall.toolCallId,
              )?.params.update;
              const allowed =
                allowPermission?.(call) && msg.params.options.find((o) => o.kind === "allow_once");
              const result = {
                outcome: allowed
                  ? { outcome: "selected", optionId: allowed.optionId }
                  : { outcome: "cancelled" },
              };
              child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
              trace.push({ reply: msg.method, result });
            }
          } else {
            NodeAssert.ok(pending, "Unexpected JSON-RPC response");
            NodeAssert.equal(msg.id, pending.id);
            if (msg.error) {
              const { message } = makeProviderFailure({
                message: `${pending.method} RPC ${msg.error.code}: ${msg.error.message}`,
              });
              const err = new Error(message);
              trace.push({ method: pending.method, error: err.message });
              pending.reject(err);
            } else {
              trace.push({ method: pending.method, result: msg.result });
              pending.resolve(msg.result);
            }
          }
        } catch (e) {
          fail(e);
        }
      });
      async function request(method, params) {
        if (failure) throw failure;
        const id = ++nextId;
        const task = Promise.withResolvers();
        pending = { ...task, id, method };
        trace.push({ request: method, params });
        const timer = setTimeout(
          () => fail(new Error(`${method} timed out`)),
          method === "session/prompt" ? 90000 : 20000,
        );
        try {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
          return await task.promise;
        } finally {
          clearTimeout(timer);
          pending = undefined;
        }
      }
      try {
        const init = await request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "t3-parity", version: "1" },
        });
        NodeAssert.deepEqual(
          init.agentInfo,
          bridgeEnabled
            ? { name: "t3-deepseek-harness-acp", version: "0.1.0-t3" }
            : { name: "deepseek-harness-acp", version: "0.0.1" },
        );
        const { sessionId, configOptions } = await request("session/new", { cwd, mcpServers: [] });
        const result = await run({ request, sessionId, configOptions, trace, label });
        const listed = await request("session/list", { cwd });
        NodeAssert.deepEqual(listed.sessions, []);
        NodeAssert.deepEqual(await request("session/close", { sessionId }), {});
        console.log(`${label} session/list=ok session/close=ok`);
        const persisted = await request("session/list", { cwd });
        NodeAssert.deepEqual(
          persisted.sessions.map((s) => s.sessionId),
          [sessionId],
        );
        const resumed = await request("session/resume", { cwd, mcpServers: [], sessionId });
        NodeAssert.ok(resumed.configOptions.some((o) => o.id === "model"));
        NodeAssert.deepEqual(await request("session/close", { sessionId }), {});
        if (failure) throw failure;
        return { trace, result };
      } finally {
        reader.close();
        child.stdin.end();
        const kill = setTimeout(() => {
          if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
            return;
          if (platform === "win32") {
            const killed = NodeChildProcess.spawnSync(
              "taskkill.exe",
              ["/PID", String(child.pid), "/T", "/F"],
              { windowsHide: true, stdio: "ignore", timeout: 3000 },
            );
            if (killed.status !== 0) child.kill("SIGKILL");
          } else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (err) {
              if (err.code !== "ESRCH") child.kill("SIGKILL");
            }
          }
        }, 2000);
        try {
          await closed;
        } finally {
          clearTimeout(kill);
        }
      }
    },
  );
}

const tokenCounters = [
  "used",
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "thoughtTokens",
  "cachedReadTokens",
  "cachedWriteTokens",
];

export function normalize(
  trace,
  cwd,
  { liveUsage = false, t3Advertisements = false, t3TurnReset = false, pwshCommand } = {},
) {
  const ids = new Map();
  function visit(v, key) {
    if (Array.isArray(v)) return v.map((item) => visit(item));
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, visit(val, k)]));
    if (["messageId", "sessionId", "toolCallId"].includes(key)) {
      const token = `${key}:${v}`;
      if (!ids.has(token)) ids.set(token, `${key}#${ids.size}`);
      return ids.get(token);
    }
    if (key === "cwd" && NodePath.resolve(v) === cwd) return "<workspace>";
    return v;
  }
  if (t3Advertisements) {
    const expected = new Set(["session/new", "session/resume"]);
    let pendingSetup;
    const sessionId = trace.find((m) => m.method === "session/new")?.result.sessionId;
    trace = trace.filter((m) => {
      if (m.request) pendingSetup = expected.has(m.request) ? m.request : undefined;
      if (m.method === pendingSetup && m.result) pendingSetup = undefined;
      if (
        m.method !== "session/update" ||
        m.params?.update?.sessionUpdate !== "available_commands_update"
      )
        return true;
      NodeAssert.ok(expected.delete(pendingSetup), "Unexpected extra T3 command advertisement");
      NodeAssert.equal(m.params.sessionId, sessionId);
      const names = m.params.update.availableCommands.map((c) => c.name);
      NodeAssert.ok(names.length && names.every((name) => typeof name === "string" && name.length));
      NodeAssert.deepEqual(names, [...new Set(names)].sort());
      return false;
    });
    NodeAssert.equal(expected.size, 0, "Missing T3 setup command advertisement");
  }
  if (t3TurnReset) {
    const sessionId = trace.find((m) => m.method === "session/new")?.result.sessionId;
    let awaitingReset = false;
    trace = trace.filter((m) => {
      if (m.request === "session/prompt") {
        NodeAssert.equal(m.params.sessionId, sessionId);
        awaitingReset = true;
      }
      if (awaitingReset && m.method === "session/update") {
        NodeAssert.deepEqual(
          m.params,
          { sessionId, update: { sessionUpdate: "plan", entries: [] } },
          "Expected T3 turn/start to clear this session's plan before other updates",
        );
        awaitingReset = false;
        return false;
      }
      if (m.method === "session/prompt")
        NodeAssert.ok(!awaitingReset, "Missing T3 turn/start plan reset");
      return true;
    });
  }
  const copy = visit(trace);
  delete copy.find((m) => m.method === "initialize").result.agentInfo;
  if (pwshCommand) {
    const updates = copy.filter((m) => m.method === "session/update").map((m) => m.params.update);
    const calls = updates.filter((u) => u.sessionUpdate === "tool_call");
    NodeAssert.equal(calls.length, 1, "Expected exactly one T3 pwsh call");
    const [call] = calls;
    NodeAssert.equal(call.kind, "execute");
    NodeAssert.equal(call.title, pwshCommand);
    NodeAssert.equal(call.rawInput.command, pwshCommand);
    NodeAssert.equal(call.status, "pending");
    Object.assign(call, { kind: "other", title: "pwsh", status: "in_progress" });
    const result = updates.find(
      (u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === call.toolCallId,
    );
    NodeAssert.ok(result && result.content.length > 0);
    NodeAssert.deepEqual(
      result.content,
      result.rawOutput.map((content) => ({ type: "content", content })),
    );
    delete result.rawOutput;
  }
  if (liveUsage) {
    for (const msg of copy) {
      const update = msg.params?.update;
      const usage =
        msg.method === "session/update" && update?.sessionUpdate === "usage_update"
          ? update
          : msg.method === "session/prompt"
            ? msg.result?.usage
            : undefined;
      if (!usage) continue;
      for (const key of tokenCounters) {
        if (typeof usage[key] === "number") usage[key] = "<usage>";
      }
    }
  }
  return copy;
}
