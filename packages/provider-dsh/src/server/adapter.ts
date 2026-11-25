import { DshSettings, decodeDshSettings } from "../settings.ts";
import type { ModelSelection, OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";
import type { AcpSessionRuntime } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  ACP_EMPTY_OPTION_VALUE,
  flattenSelectChoices,
} from "@t3tools/provider-acp/server/sessionConfig";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import type * as Context from "effect/Context";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { AcpRequestError } from "effect-acp/errors";
import {
  dshApprovalOptions,
  dshEnvironment,
  dshPermissionDisposition,
  dshSessionModeForPolicy,
  makeDshAcpRuntime,
} from "./acpSupport.ts";
import { DSH_DEFAULT, modelOption, modelRoute, encodeRoute } from "./catalog.ts";
import { DSH_PROVIDER } from "./status.ts";

const isRequestError = Schema.is(AcpRequestError);
export const DshProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
  threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: false },
  tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
} satisfies OrchestrationV2ProviderCapabilities;

export const applyDshModelSelection = Effect.fn("Dsh.applyModelSelection")(function* (
  runtime: Pick<AcpSessionRuntime["Service"], "getConfigOptions" | "setConfigOption">,
  selection: ModelSelection,
  profileDefault: string | undefined,
  settings: Pick<DshSettings, "customProviderId" | "customProviderBaseUrl"> = {
    customProviderId: "",
    customProviderBaseUrl: "",
  },
) {
  let config = yield* runtime.getConfigOptions;
  const model = modelOption(config);
  const route = modelRoute(selection.model, settings);
  const requested =
    selection.model === DSH_DEFAULT ? profileDefault : route ? encodeRoute(route) : selection.model;
  if (
    requested &&
    requested !== DSH_DEFAULT &&
    model?.type === "select" &&
    requested !== model.currentValue
  ) {
    // setConfigOption validates the advertised choices and returns the new model's controls.
    config = (yield* runtime.setConfigOption(model.id, requested)).configOptions;
  }
  const selectedEffort = getModelSelectionStringOptionValue(selection, "reasoning_effort");
  const value = selectedEffort === ACP_EMPTY_OPTION_VALUE ? "" : selectedEffort;
  const effort = config.find((o) => o.id === "reasoning_effort" && o.category === "thought_level");
  if (
    value !== undefined &&
    effort?.type === "select" &&
    effort.currentValue !== value &&
    flattenSelectChoices(effort.options).some((o) => o.value === value)
  ) {
    yield* runtime.setConfigOption(effort.id, value);
  }
  const applied = modelOption(config);
  return applied?.type === "select" ? applied.currentValue : undefined;
});

export function dshPromptFailure(cause: unknown) {
  const request = isRequestError(cause) ? cause : undefined;
  const message = request?.errorMessage ?? (cause instanceof Error ? cause.message : undefined);
  return makeProviderFailure({
    cause,
    message,
    code: request ? String(request.code) : undefined,
    class:
      request?.code === 429 ||
      /\b429\b|rate[\s_-]*limit|(?:^|[\W_])quota(?:$|[\W_])|too many requests/iu.test(message ?? "")
        ? "usage_limit"
        : "provider_error",
  });
}

type LiveConfiguration = NonNullable<AcpAdapterV2Flavor["onSessionConfigurationUpdate"]>;
interface DshAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: DshSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly services: Context.Context<FileSystem.FileSystem | Path.Path>;
  readonly assertComplete?: AcpAdapterV2Flavor["assertComplete"];
  readonly onLiveConfiguration?: LiveConfiguration;
  readonly onAvailableCommandsUpdate?: (
    cwd: string,
    commands: Parameters<NonNullable<AcpAdapterV2Flavor["onAvailableCommandsUpdate"]>>[0],
  ) => Effect.Effect<void>;
  readonly defaultModel?: Effect.Effect<string | undefined>;
}

export function dshFlavor(options: DshAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: DSH_PROVIDER,
    runtimeHarness: "DeepSeek Harness",
    capabilities: DshProviderCapabilitiesV2,
    makeRuntime: ({ processEnvironment, runtimePolicy: _policy, extraRoots: _extra, ...runtime }) =>
      makeDshAcpRuntime({
        ...runtime,
        settings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
      }).pipe(
        // The shared flavor callback lacks a cwd. Bind discovery to this runtime so
        // concurrent workspaces keep separate skill and command snapshots.
        Effect.tap((session) => {
          const publish = options.onAvailableCommandsUpdate;
          return publish
            ? session.handleSessionUpdate(({ update }) =>
                update.sessionUpdate === "available_commands_update"
                  ? publish(runtime.cwd, update.availableCommands)
                  : Effect.void,
              )
            : Effect.void;
        }),
        Effect.provide(options.services),
        Effect.mapError((e) =>
          e._tag === "PlatformError"
            ? AcpRequestError.invalidRequest("Could not prepare DSH runtime files.")
            : e,
        ),
      ),
    compactViaAdvertisedCommand: true,
    mcpOverHttp: true,
    promptFailure: dshPromptFailure,
    sessionModeForPolicy: dshSessionModeForPolicy,
    lockSessionModeToPolicy: true,
    permissionDisposition: dshPermissionDisposition,
    approvalOptions: dshApprovalOptions,
    applyModelSelection: Effect.fn(function* ({ runtime, modelSelection, startResult }) {
      const initial = modelOption(startResult.sessionSetupResult.configOptions ?? []);
      const profileDefault =
        (yield* options.defaultModel ?? Effect.undefined) ??
        (initial?.type === "select" ? initial.currentValue : undefined);
      return yield* applyDshModelSelection(
        runtime,
        modelSelection,
        profileDefault,
        options.settings,
      );
    }),
    ownedModelOptionIds: ["model", "reasoning_effort"],
    ...(options.onLiveConfiguration
      ? { onSessionConfigurationUpdate: options.onLiveConfiguration }
      : {}),
    ...(options.assertComplete ? { assertComplete: options.assertComplete } : {}),
  };
}

const makeDshAdapterV2 = (options: DshAdapterV2Options) =>
  makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: dshFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging ? { nativeLogging: options.nativeLogging } : {}),
    ...(options.testHooks ? { testHooks: options.testHooks } : {}),
  });

export type DshAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;
export const makeDshAdapterV2Driver = (
  options: Pick<
    DshAdapterV2Options,
    "onLiveConfiguration" | "onAvailableCommandsUpdate" | "defaultModel"
  > = {},
): ProviderAdapterDriver<DshSettings, DshAdapterV2DriverEnv> => ({
  driverKind: DSH_PROVIDER,
  configSchema: DshSettings,
  defaultConfig: () => decodeDshSettings({}),
  create: Effect.fn("DshAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<DshSettings>) {
      const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const logger = yield* makeAcpNativeLoggerFactory();
      return yield* makeDshAdapterV2({
        ...options,
        services: yield* Effect.context<FileSystem.FileSystem | Path.Path>(),
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* dshEnvironment(input.environment, input.config.customProviderApiKeyEnv),
        selfInvocation: yield* resolveSelfInvocation(),
        nativeLogging: (threadId) =>
          logger({ nativeEventLogger: loggers.native, provider: DSH_PROVIDER, threadId }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: DSH_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create DeepSeek Harness ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
});
