import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  RunAttemptId,
  RunId,
  ProviderSessionId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
const create = Effect.fn(function* (
  name: string,
  scenario = "ok",
  config: Partial<import("../settings.ts").DshSettings> = {},
) {
  const f = yield* fixture(scenario);
  const instance = yield* DshDriver.create({
    instanceId: ProviderInstanceId.make(name),
    displayName: name,
    enabled: true,
    config: { ...f.settings, profile: name, ...config },
    environment: [{ name: "DSH_HOME", value: f.directory, sensitive: false }],
  });
  const manage = instance.acpSessionManagement;
  if (!manage) throw new Error("missing ACP management");
  return { ...f, instance, manage };
});

it.layer(driverLayer)("DshDriver", (it) => {
  it.effect.each([
    ["modes", "approval-required", "workspace-write"],
    ["modes", "auto-accept-edits", "workspace-write"],
    ["modes", "auto", "danger-full-access"],
    ["modes-auto", "auto", "auto"],
    ["modes", "full-access", "danger-full-access"],
    ["ok", "approval-required", undefined], // Official bridge without modes.
  ] as const)("configures %j before the first prompt", ([scenario, runtimeMode, expected]) =>
    Effect.gen(function* () {
      const f = yield* create("mode-test", scenario);
      const threadId = ThreadId.make("mode-test");
      const modelSelection = { instanceId: f.instance.instanceId, model: "default" };
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode,
        interactionMode: "default",
        cwd: f.directory,
      });
      const session = yield* f.instance.orchestrationAdapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("mode-test"),
        modelSelection,
        runtimePolicy,
      });
      yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
      expect(
        (yield* f.log).filter((m) =>
          ["session/new", "session/set_mode", "session/prompt"].includes(m.method),
        ),
      ).toEqual([
        expect.objectContaining({ method: "session/new" }),
        ...(expected
          ? [{ method: "session/set_mode", sessionId: "sample-session", modeId: expected }]
          : []),
      ]);
    }),
  );
  it.effect(
    "lists workspace skills without advertising commands, launching DSH or writing the profile",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dsh-workspace-" });
        const cwd = path.join(home, "project");
        const f = yield* create("skills", "ok", {
          syncToLocalDsh: true,
          customProviderId: "sample",
          customProviderBaseUrl: "https://sample.example",
          customModels: ["sample/model"],
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
        const put = Effect.fn(function* (file: string, text: string) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, text);
          return file;
        });
        const name = "reverse-engineer-anything";
        const skill = `---\r\nname: ${name}\r\ndescription: >-\r\n  Inspect shipped\r\n  artifacts.\r\n---\r\nBody`;
        yield* put(path.join(home, ".agents", "skills", name, "SKILL.md"), skill);
        const project = yield* put(path.join(cwd, ".agents", "skills", "alias.md"), skill);
        const custom = yield* put(path.join(cwd, "custom", "hello.md"), "---\nname: hello\n---\n");
        yield* put(path.join(cwd, "custom", "missing.md"), "no frontmatter");
        yield* put(path.join(cwd, "custom", "invalid.md"), "---\nname: [\n---\n");
        const patch = "- id: skill-filesystem\n  config: { customSkillDirs: [custom] }";
        const profile = yield* put(
          path.join(f.directory, "profiles", "skills", "cordis.patch.yml"),
          patch,
        );
        const machine = yield* f.instance.snapshot.getSnapshot;
        expect(machine.slashCommands).toEqual([]);
        const log = yield* f.log;
        if (!f.instance.snapshotForCwd) throw new Error("missing workspace snapshot");
        const workspace = yield* f.instance.snapshotForCwd(cwd);
        expect(workspace.slashCommandsPending).toBe(true);
        expect(workspace.slashCommands).toEqual(machine.slashCommands);
        expect(workspace.skills).toEqual([
          {
            name,
            description: "Inspect shipped artifacts.",
            path: project,
            scope: "project",
            enabled: true,
          },
          { name: "hello", path: custom, scope: "user", enabled: true },
        ]);
        expect(yield* f.log).toEqual(log);
        expect(yield* fs.readFileString(profile)).toBe(patch);
      }),
  );
  it.effect.each([true, false])(
    "publishes scoped ACP commands and skills over disk fallback and gates /compact (advertised=%s)",
    (allowed) =>
      Effect.gen(function* () {
        const f = yield* create(
          "test-commands",
          allowed ? "commands-compact" : "commands-without-compact",
        );
        const workspace = f.instance.snapshotForCwd;
        if (!workspace || !f.instance.workspaceRescans)
          throw new Error("missing workspace discovery");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = path.join(f.directory, ".agents", "skills");
        yield* fs.makeDirectory(dir, { recursive: true });
        for (const name of ["guide", "disk-only"])
          yield* fs.writeFileString(
            path.join(dir, `${name}.md`),
            `---\nname: ${name}\ndescription: disk\n---\n`,
          );
        const before = yield* workspace(f.directory);
        expect(before.slashCommandsPending).toBe(true);
        expect(before.skills.find((s) => s.name === "guide")?.description).toBe("disk");
        const rescan = yield* f.instance.workspaceRescans.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        const threadId = ThreadId.make("dsh-compact");
        const instanceId = f.instance.instanceId;
        const modelSelection = { instanceId, model: "default" };
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: f.directory,
        });
        const session = yield* f.instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("dsh-compact"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        expect(yield* Fiber.join(rescan)).toEqual([f.directory]);
        const after = yield* workspace(f.directory);
        expect(after.slashCommandsPending).toBe(false);
        expect(after.slashCommands).toEqual(
          allowed
            ? [{ name: "compact", description: "Compact history", input: { hint: "focus" } }]
            : [],
        );
        expect(after.skills.filter((s) => s.name === "guide")).toEqual([
          {
            name: "guide",
            description: "ACP guide",
            path: "acp://skill/guide",
            scope: "agent",
            enabled: true,
          },
        ]);
        expect(after.skills.some((s) => s.name === "disk-only")).toBe(true);
        expect((yield* workspace(path.dirname(f.directory))).slashCommandsPending).toBe(true);
        if (!session.compactThread) throw new Error("missing compact action");
        const now = yield* DateTime.now;
        const compact = session.compactThread({
          threadId,
          modelSelection,
          runtimePolicy,
          providerThread,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          rootNodeId: NodeId.make("root"),
          runId: RunId.make("run"),
          attemptId: RunAttemptId.make("attempt"),
          message: {
            text: "",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message"),
          },
          appThread: {
            id: threadId,
            projectId: ProjectId.make("project"),
            title: "DSH compact",
            createdBy: "user",
            creationSource: "web",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        if (allowed) {
          yield* compact;
          yield* session.events.pipe(
            Stream.takeUntil((e) => e.type === "turn.terminal"),
            Stream.runDrain,
          );
        } else
          expect(yield* Effect.flip(compact)).toMatchObject({
            refusedBeforePrompt: true,
            cause: { _tag: "ProviderCompactionUnsupportedError" },
          });
        expect(
          (yield* f.log).filter((e) => e.method === "session/prompt").map((e) => e.compact),
        ).toEqual(allowed ? [true] : []);
        const probed = yield* f.instance.snapshot.refresh;
        expect(probed.slashCommands).toEqual(after.slashCommands);
        expect(probed.skills).toContainEqual(after.skills.find((s) => s.name === "guide"));
      }),
  );
  it.effect(
    "publishes live, model-specific reasoning without changing the profile default and injects the thread HTTP MCP",
    () =>
      Effect.gen(function* () {
        const f = yield* create("live", "ok", { customModels: ["pixel/extra"] });
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
        const [snapshot] = yield* Fiber.join(updated);
        expect(snapshot?.models.find((m) => m.isDefault)?.slug).toBe('["alpha","sample"]');
        expect(snapshot?.subProviders).toEqual([
          { name: "Alpha" },
          { name: "Beta" },
          { name: "pixel" },
        ]);
        expect(snapshot?.models.map((m) => m.subProvider)).toEqual([
          undefined,
          "Alpha",
          "Beta",
          "pixel",
        ]);
        expect(
          (yield* f.log).filter((e) => e.method === "session/new").map((e) => e.mcpTypes),
        ).toEqual([[], ["http"]]);
      }),
  );
  it.effect("merges a passive local catalog into the last probe with one group per provider", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const ready = yield* Deferred.make<void>();
      const f = yield* create("merge").pipe(
        Effect.provideService(ProviderHost.ProviderHost, {
          ...host,
          awaitServerReady: Deferred.await(ready),
        }),
      );
      const probe = yield* f.instance.snapshot.refresh;
      expect(probe.subProviders).toEqual([{ name: "Alpha" }, { name: "Beta" }]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const desktop = path.join(f.directory, "profiles", "desktop");
      yield* fs.makeDirectory(desktop, { recursive: true });
      yield* fs.writeFileString(
        path.join(desktop, "cordis.patch.yml"),
        "- id: llm-pi-ai\n  config: {providers: {alpha: {models: [{id: extra}]}, pixel: {name: ' Pixel Labs ', models: [{id: flash}]}}}",
      );
      const passive = yield* f.instance.snapshot.streamChanges.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.succeed(ready, undefined);
      const [snapshot] = yield* Fiber.join(passive);
      expect(snapshot?.subProviders).toEqual([
        { name: "Alpha" },
        { name: "Beta" },
        { name: "Pixel Labs" },
      ]);
      expect(snapshot?.models.map((m) => [m.slug, m.subProvider])).toEqual([
        ["default", undefined],
        ['["alpha","sample"]', "Alpha"],
        ['["beta","sample"]', "Beta"],
        ['["alpha","extra"]', "Alpha"],
        ['["pixel","flash"]', "Pixel Labs"],
      ]);
      expect((yield* f.log).filter((e) => e.method === "session/new")).toHaveLength(1);
    }),
  );
  it.effect("isolates instance identity, home, profile and discovery across refreshes", () =>
    Effect.gen(function* () {
      expect(DshDriver.metadata.supportsMultipleInstances).toBe(true);
      expect(DshDriver.defaultConfig()).toEqual({
        enabled: false,
        binaryPath: "dsh",
        profile: "acp",
        bridgeEnabled: true,
        syncLocalModels: true,
        customProviderId: "",
        customProviderBaseUrl: "",
        customProviderApi: "openai-responses",
        customProviderApiKeyEnv: "DEEPSEEK_CUSTOM_API_KEY",
        syncToLocalDsh: false,
        instructionsHome: "",
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
        const f = yield* create("listing", "t3-bridge");
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
  it.effect("uses the same instance model patch for live sessions and session listing", () =>
    Effect.gen(function* () {
      const f = yield* create("custom-list", "ok", {
        customProviderBaseUrl: "https://sample.example/v1",
        customModels: ["sample"],
        customProviderId: "beta",
      });
      yield* f.manage.listSessions({ cwd: f.directory });
      const threadId = ThreadId.make("dsh-overlay-thread");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: f.directory,
      });
      const modelSelection = { instanceId: f.instance.instanceId, model: "sample" };
      const live = yield* f.instance.snapshot.streamChanges.pipe(
        Stream.filter((s) => s.models.some((m) => m.slug === '["alpha","sample"]')),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      const session = yield* f.instance.orchestrationAdapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("dsh-overlay-session"),
        modelSelection,
        runtimePolicy,
      });
      yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
      expect((yield* Fiber.join(live))[0]?.subProviders).toEqual([
        { name: "Alpha" },
        { name: "Beta" },
      ]);
      const log = yield* f.log;
      const launches = log.filter((e) => e.method === "launch");
      expect(launches).toHaveLength(2);
      for (const launch of launches)
        expect(launch.patch).toMatchObject([
          {
            id: "llm-pi-ai",
            config: {
              providers: {
                beta: {
                  baseURL: "https://sample.example/v1",
                  models: [{ id: "sample", name: "sample" }],
                },
              },
            },
          },
        ]);
      expect(log).toContainEqual({
        method: "session/set_config_option",
        configId: "model",
        value: '["beta","sample"]',
      });
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
