import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { checkDshProviderStatus } from "./status.ts";
import { fixture, nodeLayer } from "./testing/fixture.ts";

it.layer(nodeLayer)("DeepSeek Harness status", (it) => {
  it.effect(
    "checks CLI health without launching profile hooks, MCP or a session on passive refresh",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        expect(yield* checkDshProviderStatus(f.settings, f.environment, false)).toMatchObject({
          installed: true,
          version: "0.2.3-alpha.2",
          status: "ready",
        });
        expect((yield* f.log).map((entry) => entry.method)).toEqual(["version"]);
      }),
  );
  it.effect("does not spawn while disabled and distinguishes missing from broken version", () =>
    Effect.gen(function* () {
      const f = yield* fixture("bad-version");
      const check = (settings: typeof f.settings) =>
        checkDshProviderStatus(settings, f.environment);
      expect(yield* check({ ...f.settings, enabled: false })).toMatchObject({
        enabled: false,
        installed: false,
        status: "disabled",
        showInteractionModeToggle: false,
      });
      expect(yield* f.log).toEqual([]);
      const path = yield* Path.Path;
      expect(
        yield* check({ ...f.settings, binaryPath: path.join(f.directory, "missing.exe") }),
      ).toMatchObject({
        installed: false,
        status: "error",
        message: expect.stringContaining("not found"),
      });
      expect(yield* check(f.settings)).toMatchObject({
        installed: true,
        version: null,
        status: "error",
        message: expect.stringContaining("--version"),
      });
      expect((yield* f.log).map((e) => e.method)).toEqual(["version"]);
    }),
  );
  it.effect("discovers grouped opaque models and reasoning using a disposable profile patch", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const snapshot = yield* checkDshProviderStatus(f.settings, f.environment);
      expect(snapshot).toMatchObject({
        status: "ready",
        version: "0.2.3-alpha.2",
        nativeSessions: { canList: true, canResume: true, canDelete: false, canLoad: false },
        supportedRuntimeModes: ["approval-required", "full-access"],
      });
      expect(snapshot.models.map((m) => [m.slug, m.name, m.isDefault])).toEqual([
        ["default", "Harness default", undefined],
        ['["alpha","sample"]', "Sample (Alpha)", true],
        ['["beta","sample"]', "Sample (Beta)", undefined],
      ]);
      expect(snapshot.models[1]?.capabilities?.optionDescriptors).toMatchObject([
        {
          id: "reasoning_effort",
          role: "reasoning",
          currentValue: "_t3/empty",
          options: [{ id: "_t3/empty" }, { id: "low" }],
        },
      ]);
      const log = yield* f.log;
      expect(log.map((e) => e.method)).toEqual([
        "version",
        "launch",
        "initialize",
        "session/new",
        "session/close",
      ]);
      const launch = log.find((e) => e.method === "launch");
      const patchPath = launch?.patchPath;
      if (!patchPath) throw new Error("probe did not pass a patch");
      const path = yield* Path.Path;
      const directory = path.dirname(patchPath);
      expect(path.basename(directory)).toMatch(/^t3-dsh-acp-probe-/u);
      expect(launch).toMatchObject({
        args: ["--profile", "test-acp", "--patch", patchPath],
        patch: [
          { id: "session-persistence-jsonl", config: { root: path.join(directory, "sessions") } },
          { id: "session-projection-cache", disabled: true },
        ],
      });
      expect(log.find((e) => e.method === "session/new")).toMatchObject({
        cwd: directory,
        mcpTypes: [],
      });
      expect(yield* (yield* FileSystem.FileSystem).exists(directory)).toBe(false);
    }),
  );
  it.effect(
    "preserves the CLI version and default on a failed ACP bootstrap and removes the patch",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("probe-error");
        const snapshot = yield* checkDshProviderStatus(f.settings, f.environment);
        expect(snapshot).toMatchObject({
          installed: true,
          status: "warning",
          version: "0.2.3-alpha.2",
          message: expect.stringContaining("ACP"),
          models: [{ slug: "default" }],
        });
        const patch = (yield* f.log).find((e) => e.patchPath)?.patchPath;
        if (!patch) throw new Error("missing patch");
        expect(
          yield* (yield* FileSystem.FileSystem).exists((yield* Path.Path).dirname(patch)),
        ).toBe(false);
      }),
  );
  it.effect("bounds an unresponsive ACP launch with the same warning fallback", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const launching = yield* Deferred.make<void>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      let launches = 0;
      const blocked = ChildProcessSpawner.make((command) =>
        ++launches === 1
          ? spawner.spawn(command)
          : Deferred.succeed(launching, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const probe = yield* checkDshProviderStatus(f.settings, f.environment).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, blocked),
        Effect.forkChild,
      );
      yield* Deferred.await(launching);
      yield* TestClock.adjust("21 seconds");
      expect(yield* Fiber.join(probe)).toMatchObject({
        installed: true,
        status: "warning",
        version: "0.2.3-alpha.2",
        message: expect.stringContaining("timed out"),
      });
    }),
  );
});
