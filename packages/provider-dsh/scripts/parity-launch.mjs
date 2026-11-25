import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { decodeDshSettings } from "../src/settings.ts";
import { dshEnvironment } from "../src/server/acpSupport.ts";
import { prepareDshLaunch } from "../src/server/launch.ts";

// Keep the Effect scope (and its secret-bearing temporary overlay) alive until DSH exits.
export function withDshLaunch(
  {
    bridgeEnabled,
    variables,
    extraPatch,
    syncLocalModels = true,
    profile = process.env.T3_DSH_PARITY_PROFILE || "acp",
  },
  run,
) {
  const desktop = process.env.T3_DSH_DESKTOP_ROOT;
  const binaryPath =
    process.env.T3_DSH_PARITY_CLI ||
    (desktop && NodePath.join(desktop, "resources", "runtime", "cli", "bin", "dsh.cmd")) ||
    "dsh";
  const settings = decodeDshSettings({
    binaryPath,
    bridgeEnabled,
    syncLocalModels,
    profile,
  });
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const env = yield* dshEnvironment(variables);
        const launch = yield* prepareDshLaunch(settings, env, extraPatch);
        const platform = yield* HostProcess.Platform;
        return yield* Effect.tryPromise({
          try: () => run({ ...launch, platform }),
          catch: (cause) => cause,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}
