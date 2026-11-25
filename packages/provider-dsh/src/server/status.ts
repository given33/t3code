import { ProviderDriverKind } from "@t3tools/contracts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseCliVersionResult,
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { AcpRequestError } from "effect-acp/errors";
import type { DshSettings } from "../settings.ts";
import { DSH_SUPPORTED_RUNTIME_MODES, makeDshAcpRuntime, resolveDshBinary } from "./acpSupport.ts";
import { configuredDshModels } from "./localSync.ts";
import { dshCatalog } from "./catalog.ts";

const isRequestError = Schema.is(AcpRequestError);
export const DSH_PROVIDER = ProviderDriverKind.make("dsh");
const auth = { status: "unknown" } as const;
const snapshot = (
  settings: DshSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  {
    config,
    nativeSessions,
    previousModels,
  }: Partial<Discovery> & { previousModels?: ServerProviderDraft["models"] | undefined } = {},
): ServerProviderDraft => {
  const { models, subProviders } = dshCatalog(settings, config, previousModels);
  return {
    ...buildServerProvider({
      driver: DSH_PROVIDER,
      presentation: {
        displayName: "DeepSeek Harness",
        showInteractionModeToggle: false,
        supportedRuntimeModes: DSH_SUPPORTED_RUNTIME_MODES,
        supportsConversationRollback: false,
      },
      enabled: settings.enabled,
      checkedAt,
      probe,
      models,
    }),
    supportsTextGeneration: false,
    ...(subProviders.length ? { subProviders } : {}),
    ...(nativeSessions ? { nativeSessions } : {}),
  };
};

export const buildInitialDshProviderSnapshot = Effect.fn("Dsh.initialSnapshot")(function* (
  settings: DshSettings,
) {
  return snapshot(settings, DateTime.formatIso(yield* DateTime.now), {
    auth,
    installed: false,
    version: null,
    status: "warning",
    message: settings.enabled
      ? "Checking DeepSeek Harness availability…"
      : "DeepSeek Harness is disabled in T3 Code settings.",
  });
});

const encodePatch = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const probeConfiguration = Effect.fn("Dsh.probeConfiguration")(function* (
  settings: DshSettings,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dsh-acp-probe-" });
  const probePatchPath = path.join(directory, "probe.json");
  yield* fs.writeFileString(
    probePatchPath,
    yield* encodePatch([
      { id: "session-persistence-jsonl", config: { root: path.join(directory, "sessions") } },
      { id: "session-projection-cache", disabled: true },
    ]),
  );
  const runtime = yield* makeDshAcpRuntime({
    settings,
    environment,
    probePatchPath,
    cwd: directory,
    mcpServers: [],
    clientInfo: { name: "t3-dsh-probe", version: "1" },
    authenticateOnAuthRequired: false,
  });
  const initialized = yield* runtime.initialize();
  if (initialized.agentInfo?.name !== "deepseek-harness-acp")
    return yield* AcpRequestError.invalidRequest("The configured CLI is not DeepSeek Harness ACP.");
  const capabilities = initialized.agentCapabilities?.sessionCapabilities;
  const started = yield* runtime.start();
  const config = yield* runtime.getConfigOptions;
  if (capabilities?.close != null) yield* runtime.closeSession(started.sessionId);
  return {
    config,
    nativeSessions: {
      canList: capabilities?.list != null,
      canResume: capabilities?.resume != null,
      canLoad: false,
      canDelete: false,
    },
  };
}, Effect.scoped);

type Discovery = Effect.Success<ReturnType<typeof probeConfiguration>>;
export const checkDshProviderStatus = Effect.fn("Dsh.checkStatus")(function* (
  settings: DshSettings,
  environment: NodeJS.ProcessEnv,
  discover = true,
  previous?: ServerProviderDraft,
) {
  if (!settings.enabled) return yield* buildInitialDshProviderSnapshot(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const env = providerProbeEnvironment(environment);
  const binary = yield* resolveDshBinary(settings.binaryPath, env);
  const command = yield* resolveSpawnCommand(binary, ["--version"], { env });
  const result = yield* spawnAndCollect(
    binary,
    ChildProcess.make(command.command, command.args, {
      shell: command.shell,
      env,
      extendEnv: false,
    }),
  ).pipe(Effect.timeout(resolveProviderProbeTimeoutMs("dsh", 10_000, env)), Effect.result);
  const missing = Result.isFailure(result) && isCommandMissingCause(result.failure);
  const version = Result.isSuccess(result)
    ? parseCliVersionResult(
        result.success,
        (text) => /^v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/mu.exec(text.trim())?.[1] ?? null,
      )
    : null;
  if (!version)
    return snapshot(settings, checkedAt, {
      auth,
      installed: !missing,
      version: null,
      status: "error",
      message: missing
        ? "DeepSeek Harness was not found. Install the desktop app or configure Binary path."
        : "Could not verify `dsh --version`. Check that Binary path points to DeepSeek Harness, not the unrelated npm dsh package.",
    });
  if (!discover) {
    const configured = yield* configuredDshModels(settings, env).pipe(Effect.result);
    if (Result.isFailure(configured))
      return snapshot(settings, checkedAt, {
        auth,
        installed: true,
        version,
        status: "warning",
        message: isRequestError(configured.failure)
          ? configured.failure.errorMessage
          : "Could not read or sync the local DSH profile patch.",
      });
    return snapshot(
      { ...settings, customModels: [...configured.success, ...settings.customModels] },
      checkedAt,
      { auth, installed: true, version, status: "ready" },
      { previousModels: previous?.version === version ? previous.models : undefined },
    );
  }
  const discovery = yield* probeConfiguration({ ...settings, binaryPath: binary }, env).pipe(
    Effect.timeout(resolveProviderProbeTimeoutMs("dsh", 20_000, env)),
    Effect.result,
  );
  if (Result.isFailure(discovery)) {
    const failure = discovery.failure;
    const reason =
      failure._tag === "TimeoutError"
        ? "timed out"
        : isRequestError(failure)
          ? `failed (ACP ${failure.code})`
          : `failed (${failure._tag})`;
    return snapshot(settings, checkedAt, {
      auth,
      installed: true,
      version,
      status: "warning",
      message: `DeepSeek Harness is installed, but the isolated ACP probe ${reason}. Check the CLI binary and ACP profile.`,
    });
  }
  return snapshot(
    settings,
    checkedAt,
    { auth, installed: true, version, status: "ready" },
    discovery.success,
  );
});
