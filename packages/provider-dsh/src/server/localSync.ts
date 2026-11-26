import * as NodeURL from "node:url";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AcpRequestError } from "effect-acp/errors";
import { type Document, isSeq, parseDocument, visit } from "yaml";
import { DEFAULT_CUSTOM_KEY_ENV, type DshSettings } from "../settings.ts";
import { bridgePatch } from "./bridgePatch.ts";
import { encodeRoute, modelRoute } from "./catalog.ts";

const { fileURLToPath, pathToFileURL } = NodeURL;

// An env-name typo must not strip the OS paths/configuration a child needs to launch.
const systemEnv =
  /^(?:PATH|PATHEXT|HOME|USER(?:NAME|DOMAIN|PROFILE)?|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|PROGRAM(?:DATA|FILES.*)|SYSTEM(?:ROOT|DRIVE)|WINDIR|COMSPEC|SHELL|TEMP|TMP|TMPDIR|TERM|LANG|PWD|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|DSH_HOME|T3CODE_.*|(?:XDG|LC|NODE|T3)_.*)$/iu;
export const isCustomKeyEnv = (name: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !systemEnv.test(name);

const pi = "llm-pi-ai";
const filename = "cordis.patch.yml";
const defaultModel = "agent-default-model";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value: unknown) => (record(value) ? value : {});
const invalid = AcpRequestError.invalidRequest;
// Existing files in a freshly created profile may be empty YAML documents (an empty patch list).
const emptyPatch = "[]";
const encodeOverlay = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
// Only serialize the opt-in read/modify/write transaction, not normal session startup.
const localWrites = Semaphore.makeUnsafe(1);

const readPatch = Effect.fn("Dsh.readProfilePatch")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file).pipe(
    Effect.catchIf(
      (e) => e.reason._tag === "NotFound",
      () => Effect.succeed(emptyPatch),
    ),
  );
  return yield* Effect.try({
    try: () => {
      const doc: Document = parseDocument(text, { logLevel: "silent" });
      if (doc.contents === null && !doc.errors.length) doc.contents = doc.createNode([]);
      if (doc.errors.length || !isSeq(doc.contents)) throw new Error("Expected a patch list");
      // Keep the original syntax tree (tags/comments/aliases) for surgical writeback. For the
      // JSON overlay, translate !!js into Cordis's expression-node representation, never eval it.
      const view = doc.clone();
      visit(view, {
        Scalar(_key, node) {
          if (node.tag === "tag:yaml.org,2002:js") {
            const expression = view.createNode({ __jsExpr: node.value });
            if (node.anchor) expression.anchor = node.anchor;
            return expression;
          }
        },
      });
      const rows: unknown = view.toJS({ maxAliasCount: 100 });
      if (!Array.isArray(rows)) throw new Error("Expected a patch list");
      return { doc, rows: rows as unknown[] };
    },
    // YAML diagnostics can contain source lines, including account secrets.
    catch: () => invalid(`Invalid DSH profile patch: ${file}`),
  });
});

type Row = Record<string, unknown>;
function pluginId(row: Row) {
  // Cordis uses id as its key; name, if present, is an additional package-name assertion.
  const name = typeof row.name === "string" ? row.name : "";
  return typeof row.id === "string" ? row.id : name.replace(/^@deepseek-ai\/dsh-/u, "");
}
function modelRows(rows: unknown[]) {
  const models = new Map<string, Row>();
  for (const row of rows) {
    if (!record(row) || row.insert) continue;
    const id = pluginId(row);
    const name = typeof row.name === "string" ? row.name : "";
    if (
      id !== defaultModel &&
      !id.startsWith("llm-") &&
      !/^@deepseek-ai\/dsh-(?:llm-|agent-default-model)/u.test(name)
    )
      continue;
    // Do not import hooks, insertions, or other plugin-manager directives across profiles.
    models.set(id, {
      ...models.get(id),
      id,
      ...(name ? { name } : {}),
      ...(Object.hasOwn(row, "config") ? { config: row.config } : {}),
      ...(Object.hasOwn(row, "disabled") ? { disabled: row.disabled } : {}),
    });
  }
  return models;
}

// Old Desktop profiles used imageMaxBytes and imageDetail. Migrate the JSON view only;
// Cordis validates each model at activation and rejects the entire plugin on legacy fields.
function normalizeDeepSeekModels(row: Row): Row {
  const plugin = row.name ?? row.id;
  if (
    typeof plugin !== "string" ||
    !/^(?:@deepseek-ai\/dsh-)?llm-deepseek(?:-api-key|-account)?$/u.test(plugin)
  )
    return row;
  const config = fields(row.config);
  if (!Array.isArray(config.models)) return row;
  let changed = false;
  const models = config.models.map((model: unknown) => {
    if (
      !record(model) ||
      (!Object.hasOwn(model, "imageMaxBytes") && !Object.hasOwn(model, "imageDetail"))
    )
      return model;
    changed = true;
    const next = { ...model };
    if (Object.hasOwn(next, "imageMaxBytes") && !Object.hasOwn(next, "imageTargetBytes"))
      next.imageTargetBytes = next.imageMaxBytes;
    delete next.imageMaxBytes;
    delete next.imageDetail;
    return next;
  });
  return changed ? { ...row, config: { ...config, models } } : row;
}

const customProvider = Effect.fn(function* (settings: DshSettings) {
  if (!settings.customProviderBaseUrl) return undefined;
  const id = settings.customProviderId || "custom";
  const models = new Map<string, { id: string; name: string }>();
  for (const entry of settings.customModels) {
    const route = modelRoute(typeof entry === "string" ? entry : entry.slug, settings);
    if (route?.[0] !== id) continue;
    const name = typeof entry === "string" ? undefined : entry.name;
    if (name || !models.has(route[1]))
      models.set(route[1], { id: route[1], name: name || route[1] });
  }
  if (!models.size) return undefined;
  const url = URL.parse(settings.customProviderBaseUrl);
  const apiKeyEnv = settings.customProviderApiKeyEnv || DEFAULT_CUSTOM_KEY_ENV;
  if (
    !url ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !isCustomKeyEnv(apiKeyEnv) ||
    ["__proto__", "constructor", "prototype"].includes(id)
  ) {
    return yield* invalid(
      "Invalid custom DSH provider ID, HTTP(S) endpoint or API key environment name.",
    );
  }
  return {
    id,
    config: {
      apiKeyEnv,
      api: settings.customProviderApi,
      baseURL: settings.customProviderBaseUrl,
      models: [...models.values()],
    },
  };
});

type Custom = NonNullable<Effect.Success<ReturnType<typeof customProvider>>>;
const mergeProvider = Effect.fn(function* (previous: unknown, custom: Custom) {
  const prev = fields(previous);
  // Never redirect existing request headers to a different endpoint. An installed-catalog
  // override also cannot coexist with an explicit models list in DSH. Pick a fresh provider ID.
  if ((prev.headers && prev.baseURL !== custom.config.baseURL) || prev.modelOverrides) {
    return yield* invalid(
      "Choose a different custom provider ID to preserve existing DSH headers or model overrides.",
    );
  }
  const additions = new Map(custom.config.models.map((m) => [m.id, m]));
  const models = (Array.isArray(prev.models) ? prev.models : []).map((m: unknown) => {
    if (!record(m) || typeof m.id !== "string") return m;
    const update = additions.get(m.id);
    if (!update) return m;
    additions.delete(m.id);
    return { ...m, ...update };
  });
  return { ...prev, ...custom.config, models: [...models, ...additions.values()] };
});

const assertWriteTarget = Effect.fn("Dsh.assertWriteTarget")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The atomic writer normally follows links. A profile alias must never redirect this opt-in
  // write into Desktop, a credentials file, or outside the selected profiles directory.
  for (const target of [path.dirname(path.dirname(file)), path.dirname(file), file]) {
    const info = yield* fs.lstat(target).pipe(
      Effect.catchIf(
        (e) => e.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );
    if (info?.type === "SymbolicLink")
      return yield* invalid("Refusing to sync through a linked DSH profile or patch.");
  }
});

const persistProvider = Effect.fn("Dsh.persistCustomProvider")(function* (
  file: string,
  current: Effect.Success<ReturnType<typeof readPatch>>,
  custom: Custom,
) {
  const { doc, rows } = current;
  const index = rows.findLastIndex(
    (r) => record(r) && !r.insert && pluginId(r) === pi && Object.hasOwn(r, "config"),
  );
  const row = fields(rows[index]);
  const providers = fields(fields(row.config).providers);
  const previous = providers[custom.id];
  const merged = yield* mergeProvider(previous, custom);
  if (Equal.equals(previous, merged)) return;
  const text = yield* Effect.try({
    try: () => {
      if (index < 0)
        doc.add(doc.createNode({ id: pi, config: { providers: { [custom.id]: merged } } }));
      else {
        const key = [index, "config", "providers", custom.id];
        // Leave the rest of this provider's YAML nodes intact too (notably tagged model metadata).
        if (!record(previous)) doc.setIn(key, doc.createNode(custom.config));
        else {
          for (const k of ["apiKeyEnv", "api", "baseURL"] as const)
            doc.setIn([...key, k], custom.config[k]);
          if (previous.models === undefined) doc.setIn([...key, "models"], doc.createNode([]));
          const oldModels: unknown[] = Array.isArray(previous.models) ? previous.models : [];
          for (const model of custom.config.models) {
            const i = oldModels.findIndex((m) => record(m) && m.id === model.id);
            if (i >= 0) doc.setIn([...key, "models", i, "name"], model.name);
            else doc.addIn([...key, "models"], doc.createNode(model));
          }
        }
      }
      return doc.toString();
    },
    catch: () => invalid("Cannot safely update this DSH YAML provider configuration."),
  });
  yield* writeFileStringAtomically({ filePath: file, contents: text });
});

const profileLocation = Effect.fn("Dsh.profileLocation")(function* (
  settings: DshSettings,
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const root = path.resolve(
    expandHomePath(environment.DSH_HOME || path.join(home, ".dsh"), home),
    "profiles",
  );
  const profile = settings.profile.trim() || "acp";
  if (
    /[<>:"/\\|?*\u0000-\u001f]/u.test(profile) ||
    profile.toLowerCase() === "node_modules" ||
    profile.endsWith(".") ||
    /^(?:CON|NUL|PRN|AUX|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(profile)
  )
    return yield* invalid("Invalid DSH profile directory name.");
  return { home, root, profile, target: path.join(root, profile, filename) };
});

const skillFilesystem = Effect.fn("Dsh.skillFilesystem")(function* (
  rows: unknown[],
  environment: NodeJS.ProcessEnv,
  home: string,
  dshHome: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const entries = rows.filter(
    (r): r is Row => record(r) && !r.insert && pluginId(r) === "skill-filesystem",
  );
  // Cordis config is replaced as a unit, whereas a later disabled-only row retains it.
  const config = fields(entries.findLast((r) => Object.hasOwn(r, "config"))?.config);
  const enabled = !entries.findLast((r) => Object.hasOwn(r, "disabled"))?.disabled;
  const existing: unknown = config.customSkillDirs;
  const customSkillDirs: unknown[] = Array.isArray(existing) ? [...existing] : [];
  const includeDefaultRoots = config.includeDefaultRoots !== false;
  const userAgents = path.join(home, ".agents");
  const agentsHome =
    typeof config.agentsHome === "string"
      ? config.agentsHome
      : environment.DSH_AGENTS_HOME || userAgents;
  const skillDshHome = typeof config.dshHome === "string" ? config.dshHome : dshHome;
  const userRoots = [agentsHome, skillDshHome].map((dir) =>
    path.resolve(expandHomePath(dir, home), "skills"),
  );
  let patch: Row | undefined;
  // An expression-valued list cannot be safely extended without evaluating user code.
  if (
    enabled &&
    environment.DSH_AGENTS_HOME &&
    includeDefaultRoots &&
    !Object.hasOwn(config, "__jsExpr") &&
    (existing === undefined || Array.isArray(existing))
  ) {
    for (const dir of [path.join(userAgents, "skills"), path.join(dshHome, "skills")]) {
      if (
        customSkillDirs.some(
          (entry) =>
            typeof entry === "string" &&
            path.isAbsolute(expandHomePath(entry, home)) &&
            path.relative(expandHomePath(entry, home), dir) === "",
        )
      )
        continue;
      const info = yield* fs.stat(dir).pipe(Effect.orElseSucceed(() => undefined));
      if (info?.type === "Directory") {
        customSkillDirs.push(dir);
        patch = { id: "skill-filesystem", config: { ...config, customSkillDirs } };
      }
    }
  }
  return {
    enabled,
    includeDefaultRoots,
    userRoots,
    customSkillDirs: customSkillDirs.filter(
      (dir): dir is string => typeof dir === "string" && !!dir.trim(),
    ),
    patch,
  };
});

export const readDshSkillRoots = Effect.fn("Dsh.readSkillRoots")(function* (
  settings: DshSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const path = yield* Path.Path;
  const { home, root, target } = yield* profileLocation(settings, environment);
  const { rows } = yield* readPatch(target);
  const { enabled, includeDefaultRoots, userRoots, customSkillDirs } = yield* skillFilesystem(
    rows,
    environment,
    home,
    path.dirname(root),
  );
  if (!enabled) return [];
  return [
    ...(includeDefaultRoots
      ? [".dsh", ".agents"].map((dir) => ({
          directory: path.join(cwd, dir, "skills"),
          scope: "project",
        }))
      : []),
    ...(includeDefaultRoots ? userRoots.map((directory) => ({ directory, scope: "user" })) : []),
    ...customSkillDirs.map((dir) => ({
      directory: path.resolve(cwd, expandHomePath(dir, home)),
      scope: "user",
    })),
  ];
});

export const locateDshBridge = Effect.fn("Dsh.locateBridge")(function* (
  settings: DshSettings,
  env: NodeJS.ProcessEnv,
  moduleUrl = import.meta.url,
) {
  if (!settings.bridgeEnabled) return {};
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  // An explicit override is authoritative, even if missing.
  const override = env.T3_DSH_BRIDGE_PATH?.trim();
  const candidates: string[] = [];
  if (override) {
    candidates.push(override);
  } else {
    const base = URL.parse(moduleUrl);
    if (base?.protocol === "file:") {
      candidates.push(
        fileURLToPath(new URL("./dsh-acp-bridge/index.js", base)),
        fileURLToPath(new URL("../../../dsh-acp-bridge/dist/index.js", base)),
      );
    }
    // A SEA can load its embedded server module from a virtual URL.
    const executable = yield* HostProcess.ExecutablePath;
    const packaged = path.join(path.dirname(executable), "dsh-acp-bridge", "index.js");
    if (!candidates.includes(packaged)) candidates.push(packaged);
  }
  for (const file of candidates) {
    const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => undefined));
    if (info?.type === "File") return { url: pathToFileURL(path.resolve(file)).href };
  }
  return {
    warning: `T3 DSH bridge unavailable at ${candidates.join(", ")}. Using the official DeepSeek Harness ACP bridge.`,
  };
});

const resolveProfile = Effect.fn("Dsh.resolveProfile")(function* (
  settings: DshSettings,
  environment: NodeJS.ProcessEnv,
  bridgeUrl?: string,
  isolated = false,
) {
  const path = yield* Path.Path;
  const { home, root, profile, target } = yield* profileLocation(settings, environment);
  const instructionsHome = settings.instructionsHome || environment.DSH_AGENTS_HOME;
  const custom = yield* customProvider(settings);
  if (!bridgeUrl && !settings.syncLocalModels && !custom && !instructionsHome)
    return { overlay: [], models: [] };
  const write =
    !isolated && settings.syncToLocalDsh && custom && profile.toLowerCase() !== "desktop";
  const load = Effect.gen(function* () {
    if (write) yield* assertWriteTarget(target);
    const current = yield* readPatch(target);
    const active = modelRows(current.rows);
    const inherited = new Map<string, Row>();
    // Deterministic priority: Web < Desktop < current profile < explicitly configured T3 provider.
    if (settings.syncLocalModels)
      for (const source of ["web", "desktop"]) {
        if (source === profile.toLowerCase()) continue;
        const { rows } = yield* readPatch(path.join(root, source, filename));
        for (const [id, row] of modelRows(rows)) {
          if (id === pi) {
            const prev = inherited.get(pi);
            inherited.set(pi, {
              ...prev,
              ...row,
              config: {
                ...fields(prev?.config),
                ...fields(row.config),
                providers: {
                  ...fields(fields(prev?.config).providers),
                  ...fields(fields(row.config).providers),
                },
              },
            });
          } else if (!active.has(id)) inherited.set(id, row);
        }
      }
    if (inherited.has(pi) || custom) {
      const source = inherited.get(pi);
      const selected = active.get(pi);
      const config = { ...fields(source?.config), ...fields(selected?.config) };
      const providers = {
        ...fields(fields(source?.config).providers),
        ...fields(fields(selected?.config).providers),
      };
      if (custom) providers[custom.id] = yield* mergeProvider(providers[custom.id], custom);
      inherited.set(pi, { ...source, ...selected, id: pi, config: { ...config, providers } });
    }
    // A disposable home runs the bundled ACP profile. Carry model configuration only,
    // never the original profile's hooks, persistence, tool plugins or instructions.
    const overlay = [...inherited.values()].map(normalizeDeepSeekModels);
    if (isolated) {
      for (const [id, row] of active) {
        if (!inherited.has(id)) overlay.push(normalizeDeepSeekModels(row));
      }
      // Some profiles replace pi-ai with named instances for separate model routes.
      for (const patch of current.rows) {
        if (!record(patch) || !Array.isArray(patch.insert)) continue;
        const adapters = patch.insert.filter(
          (row): row is Row => record(row) && row.name === "@deepseek-ai/dsh-llm-pi-ai",
        );
        if (adapters.length)
          overlay.push({ insert: adapters.map(({ id, name, config }) => ({ id, name, config })) });
      }
    }
    // Current profile rows already apply natively. Override only those that need migration.
    if (!isolated && settings.syncLocalModels) {
      for (const row of active.values()) {
        const normalized = normalizeDeepSeekModels(row);
        if (normalized !== row) overlay.push(normalized);
      }
    }
    const route = active.get(defaultModel) ?? inherited.get(defaultModel);
    const { provider, model } = fields(route?.config);
    const configuredAcp = current.rows.findLast(
      (r) => record(r) && r.id === "acp" && Object.hasOwn(r, "config"),
    );
    const hasRoute =
      !route?.disabled &&
      typeof provider === "string" &&
      provider.trim() &&
      typeof model === "string" &&
      model.trim();
    if (bridgeUrl) {
      overlay.push(
        ...bridgePatch(
          bridgeUrl,
          configuredAcp
            ? fields(fields(configuredAcp).config)
            : hasRoute
              ? { provider, model }
              : undefined,
        ),
      );
    } else if (hasRoute && !current.rows.some((r) => record(r) && r.id === "acp")) {
      overlay.push({ id: "acp", config: { provider, model } });
    }
    if (!isolated && instructionsHome) {
      const dir = path.resolve(expandHomePath(instructionsHome, home));
      const row = current.rows.findLast(
        (r) => record(r) && r.id === "agent-instructions" && Object.hasOwn(r, "config"),
      );
      // Cordis replaces (not deep-merges) config. maxBytes is required and 65536 in DSH's base bundle.
      overlay.push({
        id: "agent-instructions",
        config: {
          maxBytes: 65536,
          ...fields(fields(row).config),
          dshHome: path.basename(dir) === "AGENTS.md" ? path.dirname(dir) : dir,
        },
      });
    }
    if (!isolated && environment.DSH_AGENTS_HOME) {
      const { patch } = yield* skillFilesystem(current.rows, environment, home, path.dirname(root));
      if (patch) overlay.push(patch);
    }
    // Only the ACP agent can enumerate its built-in catalog. But explicit pi-ai routes are
    // self-describing, so the passive selector need not boot any profile hooks to show them.
    const models: Array<{ slug: string; name: string; subProvider?: string }> = [];
    const routePlugin = inherited.get(pi) ?? active.get(pi);
    if (settings.syncLocalModels && !routePlugin?.disabled) {
      for (const [provider, profile] of Object.entries(
        fields(fields(routePlugin?.config).providers),
      )) {
        const { models: entries, name } = fields(profile);
        const subProvider = typeof name === "string" ? name.trim() : undefined;
        if (!Array.isArray(entries)) continue;
        for (const model of entries) {
          if (record(model) && typeof model.id === "string" && model.id && provider) {
            models.push({
              slug: encodeRoute([provider, model.id]),
              ...(subProvider ? { subProvider } : {}),
              name: typeof model.name === "string" && model.name ? model.name : model.id,
            });
          }
        }
      }
    }
    if (write) yield* persistProvider(target, current, custom);
    return { overlay, models };
  });
  return yield* write ? localWrites.withPermits(1)(load) : load;
});

export const configuredDshModels = (settings: DshSettings, environment: NodeJS.ProcessEnv) =>
  resolveProfile(settings, environment).pipe(Effect.map(({ models }) => models));

export const prepareDshOverlay = Effect.fn("Dsh.prepareOverlay")(function* (
  settings: DshSettings,
  environment: NodeJS.ProcessEnv,
  isolated = false,
) {
  const bridge = yield* locateDshBridge(settings, environment);
  if (isolated && !bridge.url)
    return yield* invalid("Tool-free text generation requires the T3 DSH bridge.");
  const { overlay } = yield* resolveProfile(settings, environment, bridge.url, isolated);
  if (!overlay.length) return undefined;
  const contents = yield* encodeOverlay(overlay).pipe(
    Effect.mapError(() => invalid("Cannot encode the DSH model overlay.")),
  );
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dsh-overlay-" });
  const file = path.join(directory, "t3-dsh-overlay.json");
  yield* fs.writeFileString(file, contents, { mode: 0o600 });
  return file;
});
