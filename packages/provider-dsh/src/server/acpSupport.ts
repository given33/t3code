import type {
  ProviderApprovalOption,
  ProviderInstanceEnvironment,
  RuntimeMode,
} from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  acpPermissionDisposition,
  type AcpRuntimePolicy,
} from "@t3tools/provider-acp/server/clientPolicy";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Acp from "effect-acp/compat";
import { isCustomKeyEnv, prepareDshOverlay } from "./localSync.ts";
import { DEFAULT_CUSTOM_KEY_ENV, type DshSettings } from "../settings.ts";

export const DSH_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

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

export const resolveDshBinary = Effect.fn("Dsh.resolveBinary")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
) {
  const home = yield* HostProcess.HomeDirectory;
  const explicit = binaryPath.trim();
  if (explicit && explicit !== "dsh") return expandHomePath(explicit, home);
  const platform = yield* HostProcess.Platform;
  const resolve = yield* SpawnExecutableResolution;
  const find = (candidate: string) =>
    Effect.promise(async () => resolve(candidate, platform, environment));
  const fromPath = yield* find("dsh");
  // infusion/node-dsh also installs a roaming npm shim with this name. Prefer the desktop CLI over that ambiguous shim.
  if (
    fromPath &&
    !(platform === "win32" && /[\\/]AppData[\\/]Roaming[\\/]npm[\\/]dsh\.cmd$/iu.test(fromPath))
  )
    return fromPath;
  const candidates =
    platform === "win32"
      ? [
          `${environment.LOCALAPPDATA || `${home}\\AppData\\Local`}\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd`,
        ]
      : platform === "darwin"
        ? ["/Applications", `${home}/Applications`].map(
            (root) => `${root}/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`,
          )
        : [];
  for (const candidate of candidates) {
    const found = yield* find(candidate);
    if (found) return found;
  }
  return fromPath ?? "dsh";
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
  policy: AcpRuntimePolicy,
  request: Acp.RequestPermissionRequest,
) {
  const result = acpPermissionDisposition(
    policy.runtimeMode === "full-access" ? policy : { ...policy, runtimeMode: "approval-required" },
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
}

export const makeDshAcpRuntime = Effect.fn("Dsh.makeAcpRuntime")(function* ({
  settings,
  environment,
  probePatchPath,
  ...options
}: DshAcpRuntimeInput) {
  const command = yield* resolveDshBinary(settings.binaryPath, environment);
  const overlay = yield* prepareDshOverlay(settings, environment);
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...options,
      cancelBehavior: "wait-for-prompt",
      spawn: {
        command,
        args: [
          "--profile",
          settings.profile.trim() || "acp",
          ...(overlay ? ["--patch", overlay] : []),
          ...(probePatchPath ? ["--patch", probePatchPath] : []),
        ],
        env: environment,
        extendEnv: false,
        cwd: options.cwd,
      },
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
