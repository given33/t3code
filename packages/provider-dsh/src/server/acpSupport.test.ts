import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import { resolveDshBinary, dshEnvironment } from "./acpSupport.ts";

const home = "/home/test";
const desktop =
  "C:\\Users\\Sample\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd";
const bundle = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
const resolve = (
  platform: NodeJS.Platform,
  binary: string,
  files: Record<string, string>,
  environment: NodeJS.ProcessEnv = {},
) =>
  resolveDshBinary(binary, environment).pipe(
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(
      HostProcess.HomeDirectory,
      platform === "win32" ? "C:\\Users\\Sample" : home,
    ),
    Effect.provideService(SpawnExecutableResolution, (command) => files[command]),
  );
describe("DeepSeek CLI resolution", () => {
  it.effect("does not pass ambient account keys to an unconfigured instance", () =>
    Effect.gen(function* () {
      const base = {
        deepseek_api_key: "ambient-test-value",
        DEEPSEEK_API_KEY: "also-ambient",
        DEEPSEEK_CUSTOM_API_KEY: "ambient-default",
        pixel_token: "ambient-custom",
        KEEP: "present",
      };
      const configure = (value?: string) =>
        dshEnvironment(
          value === undefined ? [] : [{ name: "DEEPSEEK_API_KEY", value, sensitive: true }],
          "pixel_token",
        ).pipe(Effect.provideService(HostProcess.Environment, base));
      expect(yield* configure()).toEqual({ KEEP: "present" });
      expect(yield* configure("configured-test-value")).toEqual({
        KEEP: "present",
        DEEPSEEK_API_KEY: "configured-test-value",
      });
    }),
  );
  it.effect("preserves configured keys, but never strips core environment variables", () =>
    Effect.gen(function* () {
      const base = {
        PATH: "bin",
        HOME: "home",
        LOCALAPPDATA: "local",
        DEEPSEEK_CUSTOM_API_KEY: "discard",
        SAMPLE_SECRET: "discard",
      };
      for (const key of ["PATH", "HOME", "LOCALAPPDATA"])
        expect(
          yield* dshEnvironment([], key).pipe(Effect.provideService(HostProcess.Environment, base)),
        ).toHaveProperty(key, base[key as keyof typeof base]);
      expect(
        yield* dshEnvironment(
          [{ name: "SAMPLE_SECRET", value: "for-instance", sensitive: true }],
          "SAMPLE_SECRET",
        ).pipe(Effect.provideService(HostProcess.Environment, base)),
      ).toEqual({
        PATH: "bin",
        HOME: "home",
        LOCALAPPDATA: "local",
        SAMPLE_SECRET: "for-instance",
      });
    }),
  );
  it.effect("honors explicit paths and PATH before the desktop fallback", () =>
    Effect.gen(function* () {
      expect(yield* resolve("linux", "/custom path/dsh", { dsh: "/usr/bin/dsh" })).toBe(
        "/custom path/dsh",
      );
      expect((yield* resolve("linux", "~/bin/dsh", {})).replaceAll("\\", "/")).toBe(
        `${home}/bin/dsh`,
      );
      expect(yield* resolve("darwin", "dsh", { dsh: "/bin/dsh", [bundle]: bundle })).toBe(
        "/bin/dsh",
      );
    }),
  );
  it.effect("finds Windows desktop with spaces, including a shadowing npm dsh", () =>
    Effect.gen(function* () {
      expect(yield* resolve("win32", "", { [desktop]: desktop })).toBe(desktop);
      const custom = desktop.replace("C:\\Users\\Sample\\AppData\\Local", "E:\\Local");
      expect(
        yield* resolve(
          "win32",
          "dsh",
          { [custom]: custom, dsh: "C:\\Users\\Sample\\AppData\\Roaming\\npm\\dsh.cmd" },
          { LOCALAPPDATA: "E:\\Local" },
        ),
      ).toBe(custom);
    }),
  );
  it.effect("checks both macOS bundles in order, and leaves an unresolved dsh to the spawner", () =>
    Effect.gen(function* () {
      expect(
        yield* resolve("darwin", "dsh", { [bundle]: bundle, [home + bundle]: home + bundle }),
      ).toBe(bundle);
      expect(yield* resolve("darwin", "dsh", { [home + bundle]: home + bundle })).toBe(
        home + bundle,
      );
      expect(yield* resolve("linux", "", {})).toBe("dsh");
    }),
  );
});
