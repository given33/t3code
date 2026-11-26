import {
  isRuntimeModeAbove,
  type ProviderApprovalOption,
  type ProviderInstanceEnvironment,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  acpPermissionDisposition,
  unknownRecord,
  type AcpRuntimePolicy,
} from "@t3tools/provider-acp/server/clientPolicy";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { AcpRequestError } from "effect-acp/errors";
import * as Layer from "effect/Layer";
import type * as Acp from "effect-acp/compat";
import { prepareDshLaunch } from "./launch.ts";
export { resolveDshBinary, dshInvocation } from "./launch.ts";
import { isCustomKeyEnv } from "./localSync.ts";
import { DEFAULT_CUSTOM_KEY_ENV, type DshSettings } from "../settings.ts";

export const isDshAgent = (name: string | undefined) =>
  name === "deepseek-harness-acp" || name === "t3-deepseek-harness-acp";

export const supportsDshToolFreeSession = (init: Acp.InitializeResponse) =>
  init.agentInfo?.name === "t3-deepseek-harness-acp" &&
  init._meta?.["t3.dsh.toolFreeSession"] === true &&
  init.agentCapabilities?.sessionCapabilities?.close != null;

export const DSH_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

export function dshRuntimeModeForSessionMode(modeId: string): RuntimeMode | undefined {
  switch (modeId) {
    case "read-only":
    case "workspace-write":
      return "approval-required";
    case "danger-full-access":
      return "full-access";
    case "auto":
      return "auto";
    default:
      return undefined;
  }
}

function boundedRuntimeMode(
  policy: AcpRuntimePolicy & { readonly maxRuntimeMode?: RuntimeMode | undefined },
): RuntimeMode {
  return policy.maxRuntimeMode !== undefined &&
    isRuntimeModeAbove(policy.runtimeMode, policy.maxRuntimeMode)
    ? policy.maxRuntimeMode
    : policy.runtimeMode;
}

export const dshSessionModeForPolicy: NonNullable<AcpAdapterV2Flavor["sessionModeForPolicy"]> = (
  policy,
  modes,
) => {
  // The official bridge (also the fallback when the overlay is unavailable) has no modes.
  if (!modes) return undefined;
  const sandbox = unknownRecord(policy.sandboxPolicy)?.type;
  if (
    policy.sandboxPolicy !== undefined &&
    sandbox !== "dangerFullAccess" &&
    sandbox !== "workspaceWrite"
  )
    return "read-only";
  if (
    sandbox === "workspaceWrite" ||
    (policy.approvalPolicy !== undefined && policy.approvalPolicy !== "never")
  )
    return "workspace-write";
  switch (boundedRuntimeMode(policy)) {
    case "full-access":
      return "danger-full-access";
    case "auto":
      if (modes.availableModes.some((mode) => mode.id === "auto")) return "auto";
      // The base profile has no Auto reviewer. Never widen a managed ceiling.
      return policy.maxRuntimeMode === undefined || policy.maxRuntimeMode === "full-access"
        ? "danger-full-access"
        : "workspace-write";
    case "auto-accept-edits": // workspace-write may run shell tools without asking the ACP client.
    case "approval-required":
      return "workspace-write";
  }
};

export const dshEnvironment = Effect.fn("Dsh.environment")(function* (
  variables: ProviderInstanceEnvironment,
  customKeyEnv: string = DEFAULT_CUSTOM_KEY_ENV,
) {
  const base = yield* HostProcess.Environment;
  // Do not let another account's ambient key escape into this instance or its child processes.
  const keys = new Set(["DEEPSEEK_API_KEY", DEFAULT_CUSTOM_KEY_ENV]);
  if (isCustomKeyEnv(customKeyEnv)) keys.add(customKeyEnv.toUpperCase());
  const environment = yield* mergeProviderInstanceEnvironment(
    variables,
    Object.fromEntries(Object.entries(base).filter(([name]) => !keys.has(name.toUpperCase()))),
  );
  if (!environment.DSH_HOME) return environment;
  return {
    ...environment,
    DSH_HOME: expandHomePath(environment.DSH_HOME, yield* HostProcess.HomeDirectory),
  };
});

export function dshApprovalOptions(
  request: Acp.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const has = (kind: Acp.PermissionOption["kind"]) =>
    request.options.some((option) => option.kind === kind && option.optionId.trim() !== "");
  return [
    ...(has("allow_once") ? [{ decision: "accept", label: "Allow once" } as const] : []),
    ...(has("reject_once") ? [{ decision: "decline", label: "Deny" } as const] : []),
    { decision: "cancel", label: "Cancel" },
  ];
}

export function dshPermissionDisposition(
  policy: AcpRuntimePolicy & { readonly maxRuntimeMode?: RuntimeMode | undefined },
  request: Acp.RequestPermissionRequest,
) {
  const runtimeMode = boundedRuntimeMode(policy);
  const result = acpPermissionDisposition(
    // DSH Auto forwards requests its reviewer could not admit; let the user decide.
    { ...policy, runtimeMode: runtimeMode === "auto" ? "approval-required" : runtimeMode },
    request,
  );
  return result === "allow" &&
    !request.options.some((o) => o.kind === "allow_once" && o.optionId.trim() !== "")
    ? "ask"
    : result;
}

export interface DshAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "spawn"
> {
  readonly settings: DshSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly probePatchPath?: string;
  readonly isolatedHome?: string;
}

export const makeDshAcpRuntime = Effect.fn("Dsh.makeAcpRuntime")(function* ({
  settings,
  environment,
  probePatchPath,
  isolatedHome,
  ...options
}: DshAcpRuntimeInput) {
  const launch = yield* prepareDshLaunch(settings, environment, probePatchPath, isolatedHome);
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...options,
      cancelBehavior: "wait-for-prompt",
      spawn: {
        ...launch,
        extendEnv: false,
        cwd: options.cwd,
      },
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

export const startDshToolFreeSession = Effect.fn("Dsh.startToolFreeSession")(function* (
  settings: DshSettings,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dsh-text-" });
  const runtime = yield* makeDshAcpRuntime({
    settings,
    environment,
    isolatedHome: path.join(directory, "home"),
    cwd: directory,
    mcpServers: [],
    clientInfo: { name: "t3-dsh-text", version: "1" },
    authenticateOnAuthRequired: false,
    sessionMeta: () => ({ "t3.dsh.toolFreeSession": true }),
  });
  if (!supportsDshToolFreeSession(yield* runtime.initialize()))
    return yield* AcpRequestError.invalidRequest(
      "The DSH bridge does not advertise tool-free sessions.",
    );
  return { runtime, started: yield* runtime.start() };
});
