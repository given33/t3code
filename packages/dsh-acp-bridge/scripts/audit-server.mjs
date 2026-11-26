import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
const bin =
  process.env.T3_DSH_SERVER_BIN ||
  NodeURL.fileURLToPath(new URL("../../../apps/server/dist/bin.mjs", import.meta.url));
const bridge = NodeURL.fileURLToPath(new URL("../dist/index.js", import.meta.url));
export async function until(get, label) {
  const end = Date.now() + 45000;
  do {
    const value = await get();
    if (value) return value;
    await NodeTimersPromises.setTimeout(150);
  } while (Date.now() < end);
  throw Error(`Timed out waiting for ${label}`);
}

export async function withAuditServer(
  { root, variables, bridgeEnabled = true, settings, witness, witnessEnv },
  run,
) {
  const workspace = NodePath.join(root, "workspace");
  const t3 = NodePath.join(root, "server");
  const userdata = NodePath.join(t3, "userdata");
  const user = NodePath.join(root, "user");
  let server, ws;
  try {
    await Promise.all([
      NodeFSP.access(bin),
      NodeFSP.access(bridge),
      ...[workspace, userdata, NodePath.join(user, "roaming")].map((p) =>
        NodeFSP.mkdir(p, { recursive: true }),
      ),
    ]);
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
      T3_DSH_BRIDGE_PATH: bridge,
      ...witnessEnv,
    };
    await NodeFSP.writeFile(
      NodePath.join(userdata, "settings.json"),
      JSON.stringify({
        ...settings,
        defaultRuntimeMode: "full-access",
        providerInstances: {
          dsh: {
            driver: "dsh",
            enabled: true,
            accentColor: "#6688cc",
            config: {
              enabled: true,
              bridgeEnabled,
              binaryPath: process.env.T3_DSH_PARITY_CLI || "dsh",
            },
          },
        },
      }),
    );
    const listen = NodeNet.createServer().listen(0, "127.0.0.1");
    await NodeEvents.once(listen, "listening");
    const port = listen.address().port;
    await new Promise((done) => listen.close(done));
    const origin = `http://127.0.0.1:${port}`;
    server = NodeChildProcess.spawn(
      process.execPath,
      [
        "--import",
        witness.href,
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
    const runtime = await until(async () => {
      NodeAssert.equal(server.exitCode, null);
      try {
        return JSON.parse(
          await NodeFSP.readFile(NodePath.join(userdata, "server-runtime.json"), "utf8"),
        );
      } catch {
        return false;
      }
    }, "isolated server");
    NodeAssert.equal(runtime.pid, server.pid);
    NodeAssert.equal(runtime.origin, origin);
    console.log(JSON.stringify({ origin, pid: server.pid, t3, dsh: env.DSH_HOME }));
    const cli = (args) =>
      NodeUtil.promisify(NodeChildProcess.execFile)(
        process.execPath,
        [bin, ...args, "--base-dir", t3],
        { env, cwd: workspace, windowsHide: true, timeout: 150000 },
      ).then(
        ({ stdout }) => stdout.trim(),
        ({ code }) => {
          throw Error(`Isolated CLI ${args[0]} ${args[1]} failed (${code})`);
        },
      );
    const token = await cli(["auth", "session", "issue", "--token-only"]);
    const post = (endpoint, body) =>
      fetch(origin + endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const project = await post("/api/projects/mutate", {
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId: NodeCrypto.randomUUID(),
      title: "Isolated DSH project",
      workspaceRoot: workspace,
    });
    NodeAssert.ok(project.ok);
    const ticket = await post("/api/auth/websocket-ticket");
    NodeAssert.ok(ticket.ok);
    ws = new WebSocket(
      `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent((await ticket.json()).ticket)}`,
    );
    await NodeEvents.once(ws, "open");
    let sequence = 0;
    const rpc = async (tag, payload) => {
      const id = String(++sequence);
      ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      const signal = AbortSignal.timeout(60000);
      while (true) {
        const [evt] = await NodeEvents.once(ws, "message", { signal });
        const frame = [JSON.parse(evt.data)]
          .flat()
          .find((e) => e._tag === "Exit" && e.requestId === id);
        if (!frame) continue;
        NodeAssert.equal(frame.exit._tag, "Success", JSON.stringify(frame.exit.cause));
        return frame.exit.value;
      }
    };
    return await run({ workspace, origin, cli, rpc });
  } finally {
    ws?.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      const ended = NodeEvents.once(server, "exit");
      server.kill();
      await ended;
    }
  }
}
