// Run with the built T3 server and installed DSH. Only the model is simulated.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { answer, modelId, offlineProfile, startMock } from "./mock-llm.mjs";
const { execFile, spawn } = NodeChildProcess;
const { once } = NodeEvents;
const { randomUUID } = NodeCrypto;
const { setTimeout: delay } = NodeTimersPromises;
const { fileURLToPath } = NodeURL;
const { promisify } = NodeUtil;

const bin = fileURLToPath(new URL("../../../apps/server/dist/bin.mjs", import.meta.url));
await NodeFSP.access(bin);
const temp = await NodeFSP.realpath(NodeOS.tmpdir());
const root = await NodeFSP.mkdtemp(NodePath.join(temp, "t20-parity-"));
const t3 = NodePath.join(root, "server"),
  workspace = NodePath.join(root, "workspace");
const newLog = NodePath.join(root, "session-new.jsonl");
const calls = [],
  samples = [],
  outputs = [];
const parentPrompt = "T20 parent MCP audit";
const childPrompt = "T20 isolated child reply";
const projectId = randomUUID();
const deviceAccess = process.argv.includes("--device-access");
const route = JSON.stringify(["t3-offline", modelId]);
const parent = await startMock({ toolCalls: calls });
const child = await startMock({ textOnly: true });
const proxy = NodeHttp.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks),
      body = JSON.parse(raw);
    const input = JSON.stringify(body.input);
    const isParent = input.includes(parentPrompt);
    const names = body.tools.map((t) => t.name);
    const findTool = (suffix) => names.find((n) => n.endsWith("__" + suffix));
    if (isParent && !calls.length) {
      const listed = [
        "orchestrator_capabilities",
        "delegate_task",
        "task_status",
        "html_render",
        "device_list",
        "preview_status",
        "t3_background_wait",
      ].map((n) => [n, findTool(n) ?? null]);
      console.log("model tools", JSON.stringify(Object.fromEntries(listed)));
      NodeAssert.ok(findTool("delegate_task"));
      NodeAssert.equal(findTool("t3_background_wait"), undefined);
      calls.push(
        { name: findTool("orchestrator_capabilities"), args: {} },
        { name: findTool("device_list"), args: {} },
        { name: findTool("preview_status"), args: {} },
        {
          name: findTool("html_render"),
          args: { title: "T20 audit", height: 100, html: "<p>T20</p>" },
        },
        {
          name: findTool("delegate_task"),
          args: {
            task: childPrompt,
            mode: "wait",
            timeoutMs: 45000,
            target: { providerInstanceId: "dsh", model: route },
          },
        },
      );
    }
    samples.push({
      isParent,
      hasOrchestration: input.includes("Ordinary coding tasks need no T3 tools."),
    });
    if (isParent) {
      const results = body.input.filter((i) => i.type === "function_call_output");
      for (const result of results.slice(outputs.length)) {
        outputs.push(result.output);
      }
    }
    const resp = await fetch((isParent ? parent : child).url + "/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer offline-t3" },
      body: raw,
    });
    res.writeHead(resp.status, { "content-type": resp.headers.get("content-type") });
    for await (const chunk of resp.body) res.write(chunk);
    res.end();
  } catch (err) {
    console.error("model fixture:", err.message);
    res.writeHead(500).end();
  }
});
let server;
try {
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const { variables } = await offlineProfile(root, true, {
    url: `http://127.0.0.1:${proxy.address().port}/v1`,
  });
  const user = NodePath.join(root, "user");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) =>
        /^(path|pathext|systemroot|systemdrive|windir|comspec|localappdata|programfiles.*|programdata|temp|tmp|lang)$/i.test(
          k,
        ),
      ),
    ),
    ...Object.fromEntries(variables.map((v) => [v.name, v.value])),
    T3CODE_HOME: t3,
    T3CODE_PORT_DISCOVERY: "0",
    T3CODE_LAN: "false",
    T3CODE_TAILSCALE_SERVE: "false",
    USERPROFILE: user,
    HOME: user,
    APPDATA: NodePath.join(user, "roaming"),
    CODEX_HOME: NodePath.join(user, ".codex"),
    T20_NEW_LOG: newLog,
  };
  const binaryPath = process.env.T3_DSH_PARITY_CLI;
  const settings = {
    defaultRuntimeMode: "full-access",
    enableDeviceSupport: deviceAccess,
    enableAgentDeviceAccess: deviceAccess,
    providerInstances: {
      dsh: {
        driver: "dsh",
        accentColor: "#6688cc",
        enabled: true,
        config: { enabled: true, syncLocalModels: true, ...(binaryPath && { binaryPath }) },
      },
    },
  };
  await Promise.all(
    [workspace, NodePath.join(t3, "userdata"), env.APPDATA].map((p) =>
      NodeFSP.mkdir(p, { recursive: true }),
    ),
  );
  await NodeFSP.writeFile(NodePath.join(t3, "userdata/settings.json"), JSON.stringify(settings));
  const listen = NodeNet.createServer();
  listen.listen(0, "127.0.0.1");
  await once(listen, "listening");
  const port = listen.address().port;
  await new Promise((r) => listen.close(r));
  const origin = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [
      "--import",
      new URL("./audit-session-new.mjs", import.meta.url).href,
      bin,
      "serve",
      "--base-dir",
      t3,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-browser",
    ],
    { cwd: workspace, env, windowsHide: true, stdio: "ignore" },
  );
  console.log(JSON.stringify({ root, t3, dsh: env.DSH_HOME, origin, pid: server.pid }));
  let runtime;
  for (let i = 0; i < 200 && !runtime; i++) {
    NodeAssert.equal(server.exitCode, null, "isolated server exited");
    try {
      runtime = JSON.parse(
        await NodeFSP.readFile(NodePath.join(t3, "userdata/server-runtime.json"), "utf8"),
      );
    } catch {
      await delay(250);
    }
  }
  NodeAssert.equal(runtime?.pid, server.pid);
  NodeAssert.equal(runtime.origin, origin);
  const cli = (args) =>
    promisify(execFile)(process.execPath, [bin, ...args, "--base-dir", t3], {
      cwd: workspace,
      env,
      windowsHide: true,
      timeout: 150000,
    }).then(
      ({ stdout }) => stdout.trim(),
      ({ code }) => {
        // The raw child-process error can contain a private CLI response.
        throw new Error(`Isolated CLI command ${args[0]} ${args[1]} failed (${code})`);
      },
    );
  const token = await cli(["auth", "session", "issue", "--token-only"]);
  const project = await fetch(origin + "/api/projects/mutate", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      title: "T20 isolated project",
      workspaceRoot: workspace,
    }),
  });
  NodeAssert.ok(project.ok, `create project ${project.status}`);
  const ticketResponse = await fetch(origin + "/api/auth/websocket-ticket", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  NodeAssert.ok(ticketResponse.ok);
  const { ticket } = await ticketResponse.json();
  const ws = new WebSocket(
    `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`,
  );
  try {
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        _tag: "Request",
        id: "1",
        tag: "server.refreshProviders",
        payload: { instanceId: "dsh", cwd: workspace, fresh: true, refreshModels: true },
        headers: [],
      }),
    );
    const abort = AbortSignal.timeout(60000);
    while (true) {
      const [evt] = await once(ws, "message", { signal: abort });
      const exit = [JSON.parse(evt.data)].flat().find((m) => m._tag === "Exit");
      if (!exit) continue;
      NodeAssert.equal(exit.exit._tag, "Success");
      const snapshot = (exit.exit.value.providers ?? exit.exit.value).find(
        (p) => p.instanceId === "dsh",
      );
      console.log(
        "snapshot",
        JSON.stringify({
          status: snapshot.status,
          models: snapshot.models.map((m) => m.slug),
          nativeSessions: snapshot.nativeSessions,
          setup: snapshot.setup,
          accentColor: snapshot.accentColor,
          version: snapshot.versionAdvisory?.status,
          compatibility: snapshot.compatibilityAdvisory?.status,
        }),
      );
      NodeAssert.ok(snapshot.models.some((m) => m.slug === route));
      NodeAssert.equal(snapshot.showInteractionModeToggle, true);
      NodeAssert.equal(snapshot.reportsContextWindow, true);
      NodeAssert.deepEqual(snapshot.supportedRuntimeModes, ["approval-required", "full-access"]);
      NodeAssert.deepEqual(snapshot.nativeSessions, {
        canList: true,
        canLoad: false,
        canResume: true,
        canDelete: false,
      });
      NodeAssert.equal(snapshot.supportsConversationRollback, false);
      NodeAssert.equal(snapshot.supportsTextGeneration, !process.argv.includes("--t20-baseline"));
      NodeAssert.equal(snapshot.accentColor, "#6688cc");
      NodeAssert.ok(snapshot.compatibilityAdvisory);
      NodeAssert.ok(snapshot.versionAdvisory);
      NodeAssert.equal(snapshot.usageLimits, undefined);
      break;
    }
  } finally {
    ws.close();
  }
  const result = JSON.parse(
    await cli([
      "thread",
      "start",
      workspace,
      parentPrompt,
      "--provider",
      "dsh",
      "--model",
      route,
      "--title",
      "T20 parent",
      "--wait",
      "--json",
    ]),
  );
  if (parent.failure || child.failure) throw parent.failure ?? child.failure;
  NodeAssert.ok(JSON.stringify(result).includes(answer), "missing terminal answer");
  const observed = (await NodeFSP.readFile(newLog, "utf8"))
    .trim()
    .split("\n")
    .flatMap((line) => JSON.parse(line));
  NodeAssert.ok(
    observed.some((s) => s.name === "t3-code" && s.type === "http" && s.origin === origin),
    "session/new lacked isolated HTTP MCP",
  );
  NodeAssert.ok(samples.some((s) => s.isParent && s.hasOrchestration));
  NodeAssert.ok(
    samples.some((s) => !s.isParent),
    "child model never ran",
  );
  const [capabilities, devices, preview, html, delegated] = outputs;
  NodeAssert.equal(JSON.parse(capabilities).inheritedProviderInstanceId, "dsh");
  let deviceResult = "access disabled";
  if (deviceAccess) {
    const inventory = JSON.parse(devices);
    NodeAssert.ok(Array.isArray(inventory.hosts) && Array.isArray(inventory.devices));
    deviceResult = `listed ${inventory.hosts.length} hosts, ${inventory.devices.length} devices`;
  } else {
    NodeAssert.match(devices, /device access is turned off/i);
  }
  NodeAssert.equal(JSON.parse(preview).available, false);
  NodeAssert.ok(JSON.parse(html).htmlRender.attachmentId);
  const task = JSON.parse(delegated);
  NodeAssert.ok(task.taskId && task.childThreadId && task.childThreadId !== result.threadId);
  NodeAssert.ok(delegated.includes(answer));
  console.log(
    "MCP results",
    JSON.stringify({
      childThreadId: task.childThreadId,
      device: deviceResult,
      preview: "unavailable",
      htmlAttachment: true,
    }),
  );
  console.log(
    JSON.stringify({
      threadId: result.threadId,
      observed,
      modelRequests: samples,
      parentReceivedChildAnswer: true,
    }),
  );
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const ended = once(server, "exit");
    server.kill();
    await ended;
  }
  proxy.closeAllConnections();
  await new Promise((r) => proxy.close(r));
  await Promise.all([parent.close(), child.close()]);
  const target = await NodeFSP.realpath(root);
  NodeAssert.equal(NodePath.dirname(target), temp);
  NodeAssert.match(NodePath.basename(target), /^t20-parity-[A-Za-z0-9]+$/);
  await NodeFSP.rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
