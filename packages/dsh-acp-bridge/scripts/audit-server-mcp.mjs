// Run with the built T3 server and installed DSH. Only the model is simulated.
import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { answer, modelId, offlineProfile, startMock } from "./mock-llm.mjs";
import { withAuditServer } from "./audit-server.mjs";
const { once } = NodeEvents;
const temp = await NodeFSP.realpath(NodeOS.tmpdir());
const root = await NodeFSP.mkdtemp(NodePath.join(temp, "t20-parity-"));
const newLog = NodePath.join(root, "session-new.jsonl");
const calls = [],
  samples = [],
  outputs = [];
const parentPrompt = "T20 parent MCP audit";
const childPrompt = "T20 isolated child reply";
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
        { name: findTool("orchestrator_capabilities"), args: { search: "dsh" } },
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
try {
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const url = `http://127.0.0.1:${proxy.address().port}/v1`;
  const secondary = "t3-catalog";
  const { variables } = await offlineProfile(
    root,
    true,
    { url },
    [],
    { reasoningEfforts: { low: "low" } },
    {
      [secondary]: {
        api: "openai-responses",
        apiKeyEnv: "T3_OFFLINE_KEY",
        baseURL: url,
        models: [
          { id: "analyst", name: "Analyst", reasoningEfforts: { high: "high", max: "max" } },
          { id: "plain", name: "Plain" },
        ],
      },
    },
  );
  await withAuditServer(
    {
      root,
      variables,
      settings: { enableDeviceSupport: deviceAccess, enableAgentDeviceAccess: deviceAccess },
      witness: new URL("./audit-session-new.mjs", import.meta.url),
      witnessEnv: { T20_NEW_LOG: newLog },
    },
    async ({ workspace, origin, cli, rpc }) => {
      const resultProviders = await rpc("server.refreshProviders", {
        instanceId: "dsh",
        cwd: workspace,
        fresh: true,
        refreshModels: true,
      });
      const snapshot = (resultProviders.providers ?? resultProviders).find(
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
      NodeAssert.equal(
        snapshot.supportsConversationRollback,
        !process.argv.includes("--t20-baseline"),
      );
      NodeAssert.equal(snapshot.supportsTextGeneration, !process.argv.includes("--t20-baseline"));
      NodeAssert.equal(snapshot.accentColor, "#6688cc");
      NodeAssert.ok(snapshot.compatibilityAdvisory);
      NodeAssert.ok(snapshot.versionAdvisory);
      NodeAssert.equal(snapshot.usageLimits, undefined);
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
      const catalog = JSON.parse(capabilities);
      NodeAssert.equal(catalog.inheritedProviderInstanceId, "dsh");
      const models = catalog.providers.find((p) => p.providerInstanceId === "dsh").models;
      const effort = (id) => {
        const model = models.find((m) => m.id === id);
        NodeAssert.ok(model, `Missing MCP model ${id}`);
        return model.options?.find((o) => o.id === "reasoning_effort")?.values;
      };
      const first = effort(route),
        other = effort(JSON.stringify([secondary, "analyst"]));
      NodeAssert.ok(first.includes("low") && !first.includes("max"));
      NodeAssert.ok(other.includes("max") && !other.includes("low"));
      NodeAssert.deepEqual(effort("default"), first);
      NodeAssert.equal(effort(JSON.stringify([secondary, "plain"])), undefined);
      console.log(
        "MCP model reasoning",
        JSON.stringify({ default: first, analyst: other, plain: null }),
      );
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
    },
  );
} finally {
  proxy.closeAllConnections();
  await new Promise((r) => proxy.close(r));
  await Promise.all([parent.close(), child.close()]);
  const target = await NodeFSP.realpath(root);
  NodeAssert.equal(NodePath.dirname(target), temp);
  NodeAssert.match(NodePath.basename(target), /^t20-parity-[A-Za-z0-9]+$/);
  await NodeFSP.rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
