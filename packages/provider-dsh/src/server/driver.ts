import {
  AcpRegistryListSessionsResult,
  AcpRegistryOperationError,
  type AcpRegistryOperationErrorReason,
  TextGenerationError,
} from "@t3tools/contracts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Acp from "effect-acp/compat";
import { DshSettings, decodeDshSettings } from "../settings.ts";
import { dshEnvironment, makeDshAcpRuntime } from "./acpSupport.ts";
import { makeDshAdapterV2Driver, type DshAdapterV2DriverEnv } from "./adapter.ts";
import { dshCatalog, modelOption } from "./catalog.ts";
import { DSH_PROVIDER, buildInitialDshProviderSnapshot, checkDshProviderStatus } from "./status.ts";

const decodePage = Schema.decodeEffect(AcpRegistryListSessionsResult);
const isManagementError = Schema.is(AcpRegistryOperationError);
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DSH_PROVIDER,
  packageName: null,
});
const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "DeepSeek Harness does not provide application text generation.",
    }),
  );
const unsupportedTextGeneration: ProviderTextGeneration = {
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
  generateReviewGuide: () => unsupported("generateReviewGuide"),
  generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
};
const unsupportedOperation = (reason: AcpRegistryOperationErrorReason, message: string) =>
  Effect.fail(new AcpRegistryOperationError({ reason, message }));
const listSessions = Effect.fn("Dsh.listSessions")(
  function* (
    settings: DshSettings,
    environment: NodeJS.ProcessEnv,
    { cwd, cursor }: { readonly cwd: string; readonly cursor?: string },
  ) {
    if (!settings.enabled)
      return yield* unsupportedOperation("agent_not_configured", "DeepSeek Harness is disabled.");
    const runtime = yield* makeDshAcpRuntime({
      settings,
      environment,
      cwd,
      clientInfo: { name: "t3-dsh-session-list", version: "1" },
      mcpServers: [],
      authenticateOnAuthRequired: false,
    });
    const initialized = yield* runtime.initialize();
    const caps = initialized.agentCapabilities?.sessionCapabilities;
    if (initialized.agentInfo?.name !== "deepseek-harness-acp" || caps?.list == null)
      return yield* unsupportedOperation(
        "session_list_unsupported",
        "The agent does not advertise DeepSeek Harness session listing.",
      );
    const page = yield* runtime.listSessions(cursor);
    return yield* decodePage({
      sessions: page.sessions.map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: s.title ?? null,
        updatedAt: s.updatedAt ?? null,
        additionalDirectories: [],
        importedThreadId: null,
      })),
      nextCursor: page.nextCursor ?? null,
      canResume: caps.resume != null,
      canLoad: false,
      canDelete: false,
    });
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeout("20 seconds"),
      Effect.mapError((error) =>
        isManagementError(error)
          ? error
          : new AcpRegistryOperationError({
              reason: "probe_failed",
              message: `DeepSeek Harness session listing failed (${error._tag}).`,
            }),
      ),
    ),
);

// Profiles can install SessionStart hooks or MCP plugins. Only explicit refresh may boot one for discovery.
const DiscoverProfile = Context.Reference<boolean>("t3/dsh/DiscoverProfile", {
  defaultValue: () => false,
});
export type DshDriverEnv = DshAdapterV2DriverEnv;
export const DshDriver: ProviderDriver<DshSettings, DshDriverEnv> = {
  driverKind: DSH_PROVIDER,
  metadata: { displayName: "DeepSeek Harness", supportsMultipleInstances: true },
  configSchema: DshSettings,
  defaultConfig: () => decodeDshSettings({}),
  create: Effect.fn("DshDriver.create")(function* (input) {
    const { instanceId, displayName, accentColor, enabled } = input;
    const settings = { ...input.config, enabled };
    // Management calls and health checks run after create, with no host services in their caller.
    const services = yield* Effect.context<DshDriverEnv>();
    const environment = yield* dshEnvironment(input.environment, settings.customProviderApiKeyEnv);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DSH_PROVIDER,
      instanceId,
    });
    const stamp = withInstanceIdentity({
      instanceId,
      driverKind: DSH_PROVIDER,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    // The instance registry recreates the driver on any runtime config change. Each fresh
    // settings source, adapter and discovery cache belong to that exact configuration.
    const source = yield* makeProviderSnapshotSettingsSource(settings);
    const lastProbe = yield* Ref.make<ServerProviderDraft | undefined>(undefined);
    const live = yield* SubscriptionRef.make<ReadonlyArray<Acp.SessionConfigOption>>([]);
    const driverError = (cause: unknown) =>
      new ProviderDriverError({
        driver: DSH_PROVIDER,
        instanceId,
        detail: "Failed to create DeepSeek Harness instance.",
        cause,
      });
    const snapshot = yield* makeManagedServerProvider({
      ...source,
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: () => buildInitialDshProviderSnapshot(settings).pipe(Effect.map(stamp)),
      checkProvider: Effect.gen(function* () {
        const discover = yield* DiscoverProfile;
        const previous = yield* Ref.get(lastProbe);
        const checked = yield* checkDshProviderStatus(
          settings,
          environment,
          discover,
          previous,
        ).pipe(Effect.provide(services));
        if (discover || !checked.version || previous?.version !== checked.version)
          yield* Ref.set(lastProbe, discover ? checked : undefined);
        else if (previous && checked.status === "ready") {
          const known = new Set(previous.models.map((m) => m.slug));
          const knownGroups = new Set(previous.subProviders?.map((group) => group.name));
          const subProviders = [
            ...(previous.subProviders ?? []),
            ...(checked.subProviders ?? []).filter((group) => !knownGroups.has(group.name)),
          ];
          return stamp({
            ...previous,
            ...(subProviders.length ? { subProviders } : {}),
            checkedAt: checked.checkedAt,
            models: [...previous.models, ...checked.models.filter((m) => !known.has(m.slug))],
          });
        }
        return stamp(checked);
      }),
      enrichSnapshot: ({ getSnapshot, publishSnapshot }) =>
        SubscriptionRef.changes(live).pipe(
          Stream.runForEach((config) =>
            !modelOption(config)
              ? Effect.void
              : getSnapshot.pipe(
                  Effect.flatMap((current) =>
                    current.installed && current.status === "ready"
                      ? publishSnapshot({
                          ...current,
                          ...dshCatalog(settings, config, current.models, current.subProviders),
                        })
                      : Effect.void,
                  ),
                ),
          ),
        ),
    }).pipe(Effect.mapError(driverError));
    const refresh = snapshot.refresh.pipe(Effect.provideService(DiscoverProfile, true));
    const adapter = yield* makeDshAdapterV2Driver({
      onLiveConfiguration: (config) => SubscriptionRef.set(live, config),
      defaultModel: Ref.get(lastProbe).pipe(
        Effect.map((p) => p?.models.find((m) => m.isDefault)?.slug),
      ),
    })
      .create(input)
      .pipe(Effect.mapError(driverError));
    return {
      instanceId,
      driverKind: DSH_PROVIDER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot: { ...snapshot, refresh },
      refreshModels: () => Effect.asVoid(refresh),
      orchestrationAdapter: adapter,
      textGeneration: unsupportedTextGeneration,
      acpSessionManagement: {
        listSessions: (params) =>
          listSessions(settings, environment, params).pipe(Effect.provide(services)),
        logout: () =>
          unsupportedOperation(
            "logout_unsupported",
            "DeepSeek Harness manages authentication outside ACP.",
          ),
        deleteSession: () =>
          unsupportedOperation(
            "session_delete_unsupported",
            "DeepSeek Harness cannot delete ACP sessions.",
          ),
        listProviders: () =>
          unsupportedOperation(
            "providers_unsupported",
            "DeepSeek Harness manages providers outside ACP.",
          ),
        setProvider: () =>
          unsupportedOperation(
            "providers_unsupported",
            "DeepSeek Harness manages providers outside ACP.",
          ),
        disableProvider: () =>
          unsupportedOperation(
            "providers_unsupported",
            "DeepSeek Harness manages providers outside ACP.",
          ),
      },
    } satisfies ProviderInstance;
  }),
};
