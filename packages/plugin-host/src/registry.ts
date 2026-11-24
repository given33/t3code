import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import type { Config, InstallOptions, Panel, PluginManifest, PluginRecord } from "./types.ts";

export function object(value: unknown): value is Config {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid plugin ${key}`);
  return value;
}
const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
export function pluginId(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) ||
    reserved.test(value) ||
    value.endsWith(".")
  )
    throw new Error("Invalid plugin id");
  return value;
}
const missing = (error: unknown) => object(error) && error.code === "ENOENT";
async function readJson(file: string) {
  return JSON.parse(await NodeFSP.readFile(file, "utf8")) as unknown;
}
function within(base: string, file: string) {
  const rel = NodePath.relative(base, file);
  return (
    rel !== "" && rel !== ".." && !rel.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(rel)
  );
}
function panel(value: unknown): Panel {
  if (
    !object(value) ||
    typeof value.uiPath !== "string" ||
    !/^\/(?!\/)/.test(value.uiPath) ||
    /[\\?#%\s]/.test(value.uiPath) ||
    value.uiPath.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Invalid plugin panel path");
  return {
    title: text(value.title, "panel title"),
    uiPath: value.uiPath,
    ...(value.description === undefined
      ? {}
      : { description: text(value.description, "panel description") }),
  };
}
export async function manifest(dir: string) {
  const base = await NodeFSP.realpath(dir);
  const pkg = await readJson(NodePath.join(base, "package.json")).catch((error) => {
    if (!missing(error)) throw error;
    return null;
  });
  const embedded = object(pkg) && object(pkg.t3code) ? pkg.t3code.plugin : undefined;
  const raw = embedded ?? (await readJson(NodePath.join(base, "t3-plugin.json")));
  if (!object(raw)) throw new Error("Invalid plugin manifest");
  const relative = text(raw.entry, "entry");
  if (
    NodePath.win32.isAbsolute(relative) ||
    /[:\\]/.test(relative) ||
    !within(base, NodePath.resolve(base, relative))
  )
    throw new Error("Plugin entry must be inside its package");
  const entry = await NodeFSP.realpath(NodePath.resolve(base, relative));
  if (!within(base, entry) || !(await NodeFSP.stat(entry)).isFile())
    throw new Error("Plugin entry must be a file inside its package");
  const data: PluginManifest = {
    id: pluginId(raw.id),
    name: text(raw.name, "name"),
    version: text(raw.version, "version"),
    entry,
    description: raw.description === undefined ? "" : text(raw.description, "description"),
    ...(raw.panel === undefined ? {} : { panel: panel(raw.panel) }),
  };
  return { data, packageName: object(pkg) && typeof pkg.name === "string" ? pkg.name : data.id };
}
async function unpack(source: string, stage: string) {
  const tar = await import("tar");
  // Copy first: inspection and extraction must operate on identical archive bytes.
  const file = NodePath.join(stage, "input.tgz");
  await NodeFSP.copyFile(source, file);
  const cwd = NodePath.join(stage, "contents");
  await NodeFSP.mkdir(cwd);
  let invalid = false,
    bytes = 0,
    count = 0;
  await tar.t({
    file,
    strict: true,
    onReadEntry(e) {
      bytes += e.size;
      count++;
      const parts = e.path.split("/").filter((p) => p !== "." && p !== "");
      if (
        !["File", "Directory", "OldFile"].includes(e.type) ||
        NodePath.win32.isAbsolute(e.path) ||
        /[\\:\x00-\x1f<>"|?*]/.test(e.path) ||
        parts.some((p) => /[. ]$/.test(p) || reserved.test(p)) ||
        bytes > 256 * 1024 * 1024 ||
        count > 20000
      )
        invalid = true;
    },
  });
  if (invalid || !count) throw new Error("Unsupported or unsafe plugin archive");
  await tar.x({ file, cwd, strict: true, noChmod: true, preserveOwner: false });
  const entries = await NodeFSP.readdir(cwd, { withFileTypes: true });
  return entries.length === 1 && entries[0]?.isDirectory()
    ? NodePath.join(cwd, entries[0].name)
    : cwd;
}
export class PluginRegistry {
  readonly root: string;
  readonly file: string;
  constructor(stateDir: string) {
    this.root = NodePath.resolve(stateDir, "plugins");
    this.file = NodePath.join(this.root, "registry.json");
  }
  async list(): Promise<PluginRecord[]> {
    const data = await readJson(this.file).catch((error) => {
      if (!missing(error)) throw error;
      return [];
    });
    if (!Array.isArray(data)) throw new Error("Invalid plugin registry");
    for (const row of data) {
      if (
        !object(row) ||
        !pluginId(row.id) ||
        typeof row.installPath !== "string" ||
        typeof row.enabled !== "boolean" ||
        typeof row.linked !== "boolean" ||
        (!row.linked && row.installPath !== this.packagePath(row.id as string)) ||
        !object(row.config)
      )
        throw new Error("Invalid plugin registry entry");
    }
    return data;
  }
  private packagePath(id: string) {
    return NodePath.join(this.root, "packages", pluginId(id));
  }
  private async locked<T>(fn: (rows: PluginRecord[]) => Promise<T>) {
    await NodeFSP.mkdir(this.root, { recursive: true, mode: 0o700 });
    const { default: lockfile } = await import("proper-lockfile");
    const release = await lockfile.lock(this.file, {
      realpath: false,
      retries: { retries: 8, minTimeout: 50, maxTimeout: 500 },
    });
    try {
      return await fn(await this.list());
    } finally {
      await release();
    }
  }
  private async save(rows: PluginRecord[]) {
    const tmp = `${this.file}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      await NodeFSP.writeFile(tmp, JSON.stringify(rows, null, 2), { mode: 0o600, flag: "wx" });
      await NodeFSP.rename(tmp, this.file);
    } finally {
      await NodeFSP.rm(tmp, { force: true });
    }
  }
  async install({ spec, enable = true, link = false, config = {} }: InstallOptions) {
    if (!object(config)) throw new Error("Config must be a JSON object");
    if (!text(spec, "source").trim() || /^(?:[\\/]{2}|[a-z][\w+.-]*:\/\/)/i.test(spec))
      throw new Error("Expected a local plugin directory or .tgz file");
    const source = await NodeFSP.realpath(NodePath.resolve(spec));
    const stat = await NodeFSP.stat(source);
    if (!stat.isDirectory() && (!stat.isFile() || !source.toLowerCase().endsWith(".tgz") || link))
      throw new Error("Expected a local directory or .tgz file (link requires a directory)");
    const parent = NodePath.join(this.root, "packages");
    await NodeFSP.mkdir(this.root, { recursive: true, mode: 0o700 });
    await NodeFSP.mkdir(parent, { recursive: true, mode: 0o700 });
    const stage = await NodeFSP.mkdtemp(NodePath.join(parent, ".install-"));
    try {
      let dir = source;
      if (!stat.isDirectory()) dir = await unpack(source, stage);
      else if (!link) {
        await manifest(source);
        dir = NodePath.join(stage, "contents");
        await NodeFSP.cp(source, dir, {
          recursive: true,
          filter: async (file) => {
            if (NodePath.basename(file) === ".git") return false;
            const st = await NodeFSP.lstat(file);
            if (!st.isFile() && !st.isDirectory())
              throw new Error(
                "Plugin copies cannot contain links or special files; use --link for local development",
              );
            return true;
          },
        });
      }
      const {
        data: { entry: _entry, ...data },
        packageName,
      } = await manifest(dir);
      const installPath = link ? source : this.packagePath(data.id);
      return await this.locked(async (rows) => {
        if (rows.some((p) => p.id === data.id)) throw new Error("Plugin is already installed");
        const now = new Date().toISOString();
        const row = {
          ...data,
          packageName,
          source,
          installPath,
          linked: link,
          enabled: enable,
          config,
          installedAt: now,
          updatedAt: now,
        };
        if (!link) await NodeFSP.rename(dir, installPath);
        try {
          await this.save([...rows, row]);
        } catch (error) {
          if (!link) await NodeFSP.rm(installPath, { recursive: true });
          throw error;
        }
        return row;
      });
    } finally {
      await NodeFSP.rm(stage, { recursive: true, force: true });
    }
  }
  async update(id: string, change: { enabled: boolean } | { config: Config } | null) {
    pluginId(id);
    if (change && "config" in change && !object(change.config))
      throw new Error("Config must be a JSON object");
    await this.locked(async (rows) => {
      const index = rows.findIndex((p) => p.id === id),
        row = rows[index];
      if (!row) throw new Error("Plugin not installed");
      if (change) rows[index] = { ...row, ...change, updatedAt: new Date().toISOString() };
      else rows.splice(index, 1);
      await this.save(rows);
      if (!change && !row.linked)
        await NodeFSP.rm(this.packagePath(id), { recursive: true, force: true });
    });
  }
}
