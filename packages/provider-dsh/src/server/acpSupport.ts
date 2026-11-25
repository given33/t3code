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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Acp from "effect-acp/compat";
import { prepareDshLaunch } from "./launch.ts";
export { resolveDshBinary, dshInvocation } from "./launch.ts";
import { isCustomKeyEnv } from "./localSync.ts";
import { DEFAULT_CUSTOM_KEY_ENV, type DshSettings } from "../settings.ts";

export const isDshAgent = (name: string | undefined) =>
  name === "deepseek-harness-acp" || name === "t3-deepseek-harness-acp";

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
  const launch = yield* prepareDshLaunch(settings, environment, probePatchPath);
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
