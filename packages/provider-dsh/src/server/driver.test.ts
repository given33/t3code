import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderSessionId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Layer from "effect/Layer";
import { DshDriver } from "./driver.ts";
import { fixture, nodeLayer } from "./testing/fixture.ts";

const driverLayer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(nodeLayer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
);
const create = Effect.fn(function* (name: string, scenario = "ok") {
  const f = yield* fixture(scenario);
  const instance = yield* DshDriver.create({
    instanceId: ProviderInstanceId.make(name),
    displayName: name,
    enabled: true,
    config: { ...f.settings, profile: name },
    environment: [{ name: "DSH_HOME", value: f.directory, sensitive: false }],
  });
  const manage = instance.acpSessionManagement;
  if (!manage) throw new Error("missing ACP management");
  return { ...f, instance, manage };
});

it.layer(driverLayer)("DshDriver", (it) => {
  it.effect(
    "publishes live, model-specific reasoning without changing the profile default and injects the thread HTTP MCP",
    () =>
      Effect.gen(function* () {
        const f = yield* create("live");
        expect(yield* f.instance.snapshot.refresh).toMatchObject({
          status: "ready",
          nativeSessions: { canList: true },
        });
        const threadId = ThreadId.make("dsh-live-thread");
        const providerSessionId = ProviderSessionId.make("dsh-live-session");
        const instanceId = f.instance.instanceId;
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("test"),
          threadId,
          providerSessionId,
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:1/mcp",
          authorizationHeader: "fixture",
          browserToolsAvailable: false,
        });
        const beta = '["beta","sample"]';
        const modelSelection = {
          instanceId,
          model: beta,
          options: [{ id: "reasoning_effort", value: "high" }],
        };
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: f.directory,
        });
        const updated = yield* f.instance.snapshot.streamChanges.pipe(
          Stream.filter((s) =>
            s.models.some(
              (m) =>
                m.slug === beta &&
                m.capabilities?.optionDescriptors?.some(
                  (o) => o.id === "reasoning_effort" && o.currentValue === "high",
                ),
            ),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const session = yield* f.instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
        expect((yield* Fiber.join(updated))[0]?.models.find((m) => m.isDefault)?.slug).toBe(
          '["alpha","sample"]',
        );
        expect(
          (yield* f.log).filter((e) => e.method === "session/new").map((e) => e.mcpTypes),
        ).toEqual([[], ["http"]]);
      }),
  );
  it.effect("isolates instance identity, home, profile and discovery across refreshes", () =>
    Effect.gen(function* () {
      expect(DshDriver.metadata.supportsMultipleInstances).toBe(true);
      expect(DshDriver.defaultConfig()).toEqual({
        enabled: false,
        binaryPath: "dsh",
        profile: "acp",
        customModels: [],
      });
      const a = yield* create("profile-a");
      const b = yield* create("profile-b", "probe-error");
      const first = yield* a.instance.snapshot.refresh;
      expect(first).toMatchObject({
        instanceId: "profile-a",
        displayName: "profile-a",
        status: "ready",
        nativeSessions: { canList: true },
      });
      yield* (yield* TestProviderHost.TestProviderHostSettings).set({
        ...DEFAULT_SERVER_SETTINGS,
        enableProviderUpdateChecks: !DEFAULT_SERVER_SETTINGS.enableProviderUpdateChecks,
      });
      expect(yield* b.instance.snapshot.refresh).toMatchObject({
        instanceId: "profile-b",
        status: "warning",
        models: [{ slug: "default" }],
      });
      expect((yield* a.instance.snapshot.refresh).models).toEqual(first.models);
      for (const f of [a, b]) {
        const launches = (yield* f.log).filter((e) => e.method === "launch");
        expect(launches.length).toBeGreaterThan(0);
        expect(
          launches.every(
            (e) =>
              e.profile === f.instance.instanceId &&
              e.home === f.directory &&
              e.patch !== undefined,
          ),
        ).toBe(true);
      }
      expect(a.instance.continuationIdentity.continuationKey).not.toBe(
        b.instance.continuationIdentity.continuationKey,
      );
    }),
  );
  it.effect(
    "lists the requested cwd and page on the real instance home, without creating sessions",
    () =>
      Effect.gen(function* () {
        const f = yield* create("listing");
        const first = yield* f.manage.listSessions({ cwd: f.directory });
        expect(first).toMatchObject({
          nextCursor: "next",
          canResume: true,
          canLoad: false,
          canDelete: false,
          sessions: [{ sessionId: "page-one", cwd: f.directory }],
        });
        expect(yield* f.manage.listSessions({ cwd: f.directory, cursor: "next" })).toMatchObject({
          nextCursor: null,
          sessions: [{ sessionId: "page-two" }],
        });
        expect(
          yield* Effect.flip(f.manage.deleteSession({ cwd: f.directory, sessionId: "page-one" })),
        ).toMatchObject({ reason: "session_delete_unsupported" });
        const log = yield* f.log;
        expect(
          log.filter((e) => e.method === "session/list").map((e) => [e.cwd, e.cursor]),
        ).toEqual([
          [f.directory, undefined],
          [f.directory, "next"],
        ]);
        expect(
          log.some((e) => e.method === "session/new" || e.patch || e.method === "session/delete"),
        ).toBe(false);
      }),
  );
  it.effect("does not issue a list request to an agent missing the capability", () =>
    Effect.gen(function* () {
      const f = yield* create("old", "no-list");
      expect(yield* Effect.flip(f.manage.listSessions({ cwd: f.directory }))).toMatchObject({
        reason: "session_list_unsupported",
      });
      expect((yield* f.log).filter((e) => e.method.startsWith("session/"))).toEqual([]);
    }),
  );
});
