import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as tar from "tar";
import { PluginHostManager, PluginRegistry } from "./index.ts";
const sourceCode = `import { appendFile } from 'node:fs/promises'; import * as NodePath from 'node:path';
export default { apply(ctx, config) { const log = text => appendFile(NodePath.join(ctx.stateDir, 'events'), text+'\\n');
 ctx.onShutdown(()=>log('shutdown')); ctx.registerHttpHandler(async(req, subPath)=> Response.json({subPath, config, method:req.method, body: await req.text(), cookie:req.headers.get('cookie')}));
 return { dispose:()=>log('dispose') }; } };`;
async function fixture(t: NodeTest.TestContext, code = sourceCode) {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "plugin-host-test-"));
  const state = NodePath.join(base, "userdata"),
    source = NodePath.join(base, "source");
  await NodeFSP.mkdir(source);
  const manifest = {
    name: "Test plugin",
    id: "fixture",
    version: "1",
    entry: "./plugin.mjs",
    panel: { title: "Panel", uiPath: "/panel" },
  };
  const write = async (changes: Record<string, unknown> = {}) =>
    NodeFSP.writeFile(
      NodePath.join(source, "package.json"),
      JSON.stringify({ name: "package-name", t3code: { plugin: { ...manifest, ...changes } } }),
    );
  await write();
  await NodeFSP.writeFile(NodePath.join(source, "plugin.mjs"), code);
  const options = {
    t3StateDir: state,
    t3BaseDir: base,
    getServerInfo: () => ({
      port: null,
      localOrigin: null,
      host: undefined,
      staticDir: undefined,
      environmentId: null,
    }),
    issueLocalSession: async () => null,
  };
  const host = new PluginHostManager(options);
  t.after(async () => {
    await host.disposeAll();
    await NodeFSP.rm(base, { recursive: true, force: true });
  });
  return { base, state, source, host, write, manifest, options };
}
NodeTest.test(
  "manifest rejects traversal, nonlocal paths, reserved ids and unsafe panels before publishing",
  async (t) => {
    const { host, source, write, base } = await fixture(t);
    await NodeFSP.writeFile(NodePath.join(base, "escape.mjs"), "");
    for (const bad of [
      { id: "../escape" },
      { id: "con" },
      { id: "a." },
      { id: "a".repeat(65) },
      { entry: "../escape.mjs" },
      { entry: NodePath.join(base, "escape.mjs") },
      { panel: { title: "Bad", uiPath: "/../escape" } },
    ]) {
      await write(bad);
      await NodeAssert.rejects(host.installPlugin({ spec: source }));
    }
    await NodeAssert.rejects(host.installPlugin({ spec: "//not-local/share" }), /local/);
    NodeAssert.deepEqual(await host.listPlugins(), []);
    NodeAssert.deepEqual(await NodeFSP.readdir(NodePath.join(host.registry.root, "packages")), []);
  },
);
NodeTest.test("copy, lifecycle, config persistence, HTTP dispatch and shutdown", async (t) => {
  const { host, source, options } = await fixture(t);
  await host.startAll();
  await host.installPlugin({ spec: source });
  const events = NodePath.join(host.registry.root, "state", "fixture", "events");
  await NodeFSP.unlink(NodePath.join(source, "plugin.mjs"));
  NodeAssert.equal((await host.listPlugins())[0]?.status, "active");
  await host.updatePluginConfig("fixture", { x: 7 });
  NodeAssert.equal(await NodeFSP.readFile(events, "utf8"), "dispose\nshutdown\n");
  const request = new Request("data:,panel", {
    method: "POST",
    body: "hello",
    headers: { cookie: "not-forwarded" },
  });
  NodeAssert.deepEqual(
    await (await host.dispatchExtensionHttp("fixture", request, "/panel")).json(),
    {
      config: { x: 7 },
      subPath: "/panel",
      method: "POST",
      body: "hello",
      cookie: null,
    },
  );
  await host.disablePlugin("fixture");
  NodeAssert.equal((await host.dispatchExtensionHttp("fixture", request, "/")).status, 404);
  await host.enablePlugin("fixture");
  await host.disposeAll();
  const second = new PluginHostManager(options);
  try {
    await second.startAll();
    NodeAssert.deepEqual((await second.listPlugins())[0]?.config, { x: 7 });
    await second.removePlugin("fixture");
    NodeAssert.deepEqual(await second.listPlugins(), []);
  } finally {
    await second.disposeAll();
  }
  NodeAssert.equal((await NodeFSP.readFile(events, "utf8")).split("dispose\n").length - 1, 4);
});
NodeTest.test("npm tgz / fallback manifest, corrupt or invalid archive rolls back", async (t) => {
  const { host, source, base, manifest } = await fixture(t);
  const spec = NodePath.join(base, "pkg.tgz");
  await NodeFSP.rm(NodePath.join(source, "package.json"));
  await NodeFSP.writeFile(NodePath.join(source, "t3-plugin.json"), JSON.stringify(manifest));
  await tar.c({ cwd: source, prefix: "package", gzip: true, file: spec }, ["."]);
  await host.installPlugin({ spec, enable: false });
  NodeAssert.equal((await host.listPlugins())[0]?.status, "disabled");
  await host.removePlugin("fixture");
  await NodeFSP.writeFile(NodePath.join(source, "t3-plugin.json"), "{}");
  await tar.c({ cwd: source, prefix: "package", gzip: true, file: spec }, ["."]);
  await NodeAssert.rejects(host.installPlugin({ spec }));
  await NodeFSP.writeFile(spec, "not a tarball");
  await NodeAssert.rejects(host.installPlugin({ spec }));
  NodeAssert.deepEqual(await host.listPlugins(), []);
  NodeAssert.deepEqual(await NodeFSP.readdir(NodePath.join(host.registry.root, "packages")), []);
});
NodeTest.test(
  "failed apply and a worker exit isolate only that plugin; uninstall never removes linked source",
  async (t) => {
    const { host, source, base, write } = await fixture(
      t,
      `export const apply = () => { throw new Error('bad plugin'); };`,
    );
    await host.installPlugin({ spec: source });
    NodeAssert.match((await host.listPlugins())[0]?.error ?? "", /bad plugin/);
    await write({ id: "other" });
    await NodeFSP.writeFile(NodePath.join(source, "plugin.mjs"), sourceCode);
    await host.installPlugin({ spec: source, link: true });
    NodeAssert.equal((await host.listPlugins()).find((p) => p.id === "other")?.status, "active");
    await host.disablePlugin("other");
    await NodeFSP.writeFile(
      NodePath.join(source, "plugin.mjs"),
      "export function apply(){process.exit(1)}",
    );
    await host.enablePlugin("other");
    NodeAssert.match(
      (await host.listPlugins()).find((p) => p.id === "other")?.error ?? "",
      /worker exited/,
    );
    await host.removePlugin("other");
    NodeAssert.ok((await NodeFSP.stat(NodePath.join(base, "source", "plugin.mjs"))).isFile());
  },
);
NodeTest.test(
  "independent registry writers preserve both installs and do not execute plugins",
  async (t) => {
    const { source, base, state, host, write } = await fixture(t);
    const other = NodePath.join(base, "other");
    await NodeFSP.cp(source, other, { recursive: true });
    await write({ id: "second" });
    const a = new PluginRegistry(state),
      b = new PluginRegistry(state);
    await Promise.all([a.install({ spec: source }), b.install({ spec: other })]);
    NodeAssert.deepEqual((await a.list()).map((row) => row.id).sort(), ["fixture", "second"]);
    await host.startAll();
    NodeAssert.deepEqual(
      (await host.listPlugins()).map((row) => row.status),
      ["active", "active"],
    );
  },
);

NodeTest.test(
  "realpath rejects an entry under an escaping junction, and archive traversal never reaches disk",
  async (t) => {
    const { host, source, base, write } = await fixture(t);
    const outside = NodePath.join(base, "outside");
    await NodeFSP.mkdir(outside);
    await NodeFSP.writeFile(NodePath.join(outside, "entry.mjs"), "");
    await NodeFSP.symlink(outside, NodePath.join(source, "alias"), "junction");
    await write({ entry: "alias/entry.mjs" });
    await NodeAssert.rejects(
      host.installPlugin({ spec: source, link: true }),
      /inside its package/,
    );
    const spec = NodePath.join(base, "unsafe.tgz");
    await tar.c({ cwd: outside, prefix: "../escaped", gzip: true, file: spec }, ["entry.mjs"]);
    await NodeAssert.rejects(host.installPlugin({ spec }), /unsafe/);
    NodeAssert.deepEqual(await NodeFSP.readdir(NodePath.join(host.registry.root, "packages")), []);
    NodeAssert.deepEqual(await host.listPlugins(), []);
  },
);
NodeTest.test(
  "a handler exception cleans up only its instance and releases extension routes",
  async (t) => {
    const { host, source } = await fixture(
      t,
      `export function apply(ctx) { ctx.registerHttpHandler(()=>{throw new Error('handler failed')}); return () => {}; }`,
    );
    await host.installPlugin({ spec: source });
    const request = new Request("data:,");
    NodeAssert.equal((await host.dispatchExtensionHttp("fixture", request, "/")).status, 500);
    NodeAssert.equal((await host.listPlugins())[0]?.status, "error");
    NodeAssert.equal((await host.dispatchExtensionHttp("fixture", request, "/")).status, 404);
  },
);

NodeTest.test(
  "a running host reconciles offline CLI writes without executing plugins in the writer",
  { timeout: 10000 },
  async (t) => {
    const { options, state, source } = await fixture(
      t,
      `export async function apply(ctx){ await ctx.issueLocalSession(); }`,
    );
    const started = Promise.withResolvers<void>(),
      stopped = Promise.withResolvers<void>();
    const live = new PluginHostManager({
      ...options,
      issueLocalSession: async () => {
        started.resolve();
        return null;
      },
      releaseSessions: async () => {
        stopped.resolve();
      },
    });
    try {
      await live.startAll();
      const cli = new PluginRegistry(state);
      await cli.install({ spec: source });
      await started.promise;
      await cli.update("fixture", { enabled: false });
      await stopped.promise;
      NodeAssert.equal((await live.listPlugins())[0]?.status, "disabled");
    } finally {
      await live.disposeAll();
    }
  },
);
