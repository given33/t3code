import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import { PluginRegistry, manifest } from "./registry.ts";
import { workerModule } from "./workerModule.ts";
import type {
  Config,
  InstallOptions,
  PluginHostContext,
  PluginOrchestration,
  PluginRecord,
  PluginView,
  ServerInfo,
  SessionOptions,
  LocalSession,
} from "./types.ts";
export * from "./types.ts";
export { PluginRegistry };

interface HostOptions {
  t3StateDir: string;
  t3BaseDir: string;
  staticDir?: string | undefined;
  getServerInfo(): ServerInfo;
  issueLocalSession(id: string, options?: SessionOptions): Promise<LocalSession | null>;
  orchestration?(id: string): PluginOrchestration;
  releaseSessions?(id: string): Promise<void>;
}
interface Reply {
  body: ReadableStream<Uint8Array> | null;
  status: number;
  statusText: string;
  headers: [string, string][];
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
class Instance {
  status: PluginView["status"] = "starting";
  error?: string;
  worker?: NodeWorkerThreads.Worker;
  readonly key: string;
  private sequence = 0;
  private pending = new Map<number, (error?: string, value?: Reply) => void>();
  constructor(record: PluginRecord) {
    this.key = JSON.stringify(record);
  }
  attach(
    worker: NodeWorkerThreads.Worker,
    issue: PluginHostContext["issueLocalSession"],
    orchestration: PluginOrchestration | undefined,
    failed: (error: string) => void,
  ) {
    this.worker = worker;
    worker.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.session && msg.port instanceof NodeWorkerThreads.MessagePort) {
        void issue(msg.options)
          .then(
            (session) => msg.port.postMessage({ session }, []),
            () => msg.port.postMessage({ error: "Session issuance failed" }, []),
          )
          .finally(() => msg.port.close());
      } else if (msg.orchestration && msg.port instanceof NodeWorkerThreads.MessagePort) {
        // A stopping worker may still fence its source, but may not start a new turn.
        const invoke = async () => {
          if (!orchestration) throw new Error("Orchestration unavailable");
          switch (msg.orchestration) {
            case "getThreadSnapshot":
              return orchestration.getThreadSnapshot(msg.args[0]);
            case "interruptActiveTurn":
              return orchestration.interruptActiveTurn(msg.args[0], msg.args[1]);
            case "continueThreadTurn":
              if (this.worker !== worker) throw new Error("Plugin stopped");
              return orchestration.continueThreadTurn(msg.args[0]);
            default:
              throw new Error("Unknown orchestration method");
          }
        };
        void invoke()
          .then(
            (value) => msg.port.postMessage({ value }),
            () => msg.port.postMessage({ error: "Orchestration operation refused or failed" }),
          )
          .finally(() => msg.port.close());
      } else this.pending.get(msg.id)?.(msg.error, msg.value);
    });
    const lost = (error: string) => {
      for (const reply of this.pending.values()) reply(error);
      if (this.worker) failed(error);
    };
    worker.on("error", (error) => lost(message(error)));
    worker.once("exit", (code) => {
      lost(`Plugin worker exited (${code})`);
    });
  }
  async call(op: string, input?: unknown, transfer: NodeWorkerThreads.Transferable[] = []) {
    const worker = this.worker;
    if (!worker) throw new Error("Plugin stopped");
    const id = ++this.sequence;
    return new Promise<Reply | undefined>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(`Plugin ${op} timed out`),
        op === "stop" ? 3000 : 30000,
      );
      const finish = (error?: string, value?: Reply) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error !== undefined) reject(new Error(error));
        else resolve(value);
      };
      this.pending.set(id, finish);
      try {
        worker.postMessage({ id, op, input }, transfer);
      } catch (error) {
        finish(message(error));
      }
    });
  }
  async stop() {
    const worker = this.worker;
    if (!worker) return;
    const cleanup = this.call("stop");
    delete this.worker;
    try {
      await cleanup;
    } finally {
      await worker.terminate();
    }
  }
}
export class PluginHostManager {
  readonly registry: PluginRegistry;
  private readonly options: HostOptions;
  private readonly instances = new Map<string, Instance>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(options: HostOptions) {
    this.options = options;
    this.registry = new PluginRegistry(options.t3StateDir);
  }
  private enqueue<T>(fn: () => Promise<T>) {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
  private async stop(id: string, instance: Instance) {
    try {
      await instance.stop();
    } catch (err) {
      console.warn(`[${id}] cleanup: ${message(err)}`);
    }
    await this.options.releaseSessions?.(id);
  }
  private async activate(row: PluginRecord) {
    const instance = new Instance(row);
    this.instances.set(row.id, instance);
    const fail = (error: string) => {
      instance.status = "error";
      instance.error = error;
    };
    try {
      const { data } = await manifest(row.installPath);
      if (row.id !== data.id) throw new Error("Installed manifest id changed");
      const { t3StateDir, t3BaseDir, staticDir } = this.options;
      const stateDir = NodePath.join(this.registry.root, "state", row.id);
      await NodeFSP.mkdir(stateDir, { recursive: true, mode: 0o700 });
      const entry = `${NodeURL.pathToFileURL(data.entry).href}?v=${NodeCrypto.randomUUID()}`;
      const orchestration = this.options.orchestration?.(row.id);
      instance.attach(
        new NodeWorkerThreads.Worker(workerModule, {
          workerData: {
            entry,
            hasOrchestration: orchestration !== undefined,
            config: row.config,
            info: this.options.getServerInfo(),
            context: { pluginId: row.id, stateDir, t3StateDir, t3BaseDir, staticDir },
          },
        }),
        (options) =>
          instance.worker && !this.closed
            ? this.options.issueLocalSession(row.id, options)
            : Promise.resolve(null),
        orchestration,
        (error) => {
          fail(error);
          // The worker is already exiting. Do not wait for a message from it.
          delete instance.worker;
          void this.options
            .releaseSessions?.(row.id)
            .catch((err) => console.warn(`[${row.id}] ${message(err)}`));
        },
      );
      await instance.call("start");
      instance.status = "active";
    } catch (err) {
      fail(message(err));
      await this.stop(row.id, instance);
    }
  }
  private async sync() {
    if (this.closed) return;
    const rows = await this.registry.list();
    await Promise.all(
      [...this.instances].map(async ([id, instance]) => {
        const row = rows.find((p) => p.id === id);
        if (row?.enabled && instance.key === JSON.stringify(row)) return;
        this.instances.delete(id);
        await this.stop(id, instance);
      }),
    );
    await Promise.all(
      rows
        .filter((row) => row.enabled && !this.instances.has(row.id))
        .map((row) => this.activate(row)),
    );
  }
  private changed = () => {
    void this.enqueue(() => this.sync()).catch((err) =>
      console.warn(`Plugin registry: ${message(err)}`),
    );
  };
  startAll() {
    NodeFS.watchFile(this.registry.file, { interval: 1000, persistent: false }, this.changed);
    return this.enqueue(() => this.sync());
  }
  async listPlugins(): Promise<PluginView[]> {
    return (await this.registry.list()).map((row) => {
      const instance = this.instances.get(row.id);
      return {
        ...row,
        status: row.enabled ? (instance?.status ?? "starting") : "disabled",
        ...(instance?.error === undefined ? {} : { error: instance.error }),
      };
    });
  }
  installPlugin(input: InstallOptions) {
    return this.enqueue(async () => {
      const row = await this.registry.install(input);
      await this.sync();
      return row.id;
    });
  }
  private change(id: string, change: { enabled: boolean } | { config: Config } | null) {
    return this.enqueue(async () => {
      if (!change) {
        const instance = this.instances.get(id);
        if (instance) {
          this.instances.delete(id);
          await this.stop(id, instance);
        }
      }
      await this.registry.update(id, change);
      await this.sync();
    });
  }
  enablePlugin(id: string) {
    return this.change(id, { enabled: true });
  }
  disablePlugin(id: string) {
    return this.change(id, { enabled: false });
  }
  updatePluginConfig(id: string, config: Config) {
    return this.change(id, { config });
  }
  removePlugin(id: string) {
    return this.change(id, null);
  }
  async dispatchExtensionHttp(id: string, request: Request, subPath: string) {
    const instance = this.instances.get(id);
    if (instance?.status !== "active") return new Response(null, { status: 404 });
    try {
      const headers = new Headers(request.headers);
      for (const name of ["authorization", "cookie", "dpop", "proxy-authorization"])
        headers.delete(name);
      const body = request.body;
      const reply = await instance.call(
        "http",
        { url: request.url, method: request.method, headers: [...headers], subPath, body },
        body ? [body as NodeWorkerThreads.Transferable] : [],
      );
      if (!reply) throw new Error("Plugin returned no HTTP response");
      return new Response(reply.body, reply);
    } catch (err) {
      instance.status = "error";
      instance.error = message(err);
      await this.enqueue(async () => {
        if (this.instances.get(id) === instance) await this.stop(id, instance);
      });
      return new Response(null, { status: 500 });
    }
  }
  disposeAll() {
    this.closed = true;
    NodeFS.unwatchFile(this.registry.file, this.changed);
    return this.enqueue(async () => {
      await Promise.all([...this.instances].map(([id, instance]) => this.stop(id, instance)));
      this.instances.clear();
    });
  }
}
