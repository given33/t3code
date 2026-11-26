import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import type { DshSettings } from "../settings.ts";
import { prepareDshOverlay } from "./localSync.ts";

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

// Mirror the installed Windows shim without invoking cmd.exe for paths containing spaces.
export function dshInvocation(binary: string, environment: NodeJS.ProcessEnv) {
  const root =
    /^(.*[\\/]DeepSeek Harness)[\\/]resources[\\/]runtime[\\/]cli[\\/]bin[\\/]dsh\.cmd$/iu.exec(
      binary,
    )?.[1];
  if (!root) return { command: binary, args: [], env: environment };
  return {
    command: `${root}/DeepSeek Harness.exe`,
    args: [
      "--expose-internals",
      `${root}/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`,
    ],
    env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
  };
}

export const prepareDshLaunch = Effect.fn("Dsh.prepareLaunch")(function* (
  settings: DshSettings,
  environment: NodeJS.ProcessEnv,
  probePatchPath?: string,
  isolatedHome?: string,
) {
  const launch = dshInvocation(
    yield* resolveDshBinary(settings.binaryPath, environment),
    environment,
  );
  const overlay = yield* prepareDshOverlay(settings, environment, isolatedHome !== undefined);
  return {
    command: launch.command,
    args: [
      ...launch.args,
      "--profile",
      isolatedHome ? "acp" : settings.profile.trim() || "acp",
      ...(overlay ? ["--patch", overlay] : []),
      ...(probePatchPath ? ["--patch", probePatchPath] : []),
    ],
    env: isolatedHome
      ? { ...launch.env, DSH_HOME: isolatedHome, DSH_TELEMETRY_DISABLED: "1" }
      : launch.env,
  };
});
