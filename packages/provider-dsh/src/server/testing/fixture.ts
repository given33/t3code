import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { decodeDshSettings } from "../../settings.ts";

export const nodeLayer = Layer.merge(NodeServices.layer, NodeCrypto.layer);
const readLogEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.String,
      args: Schema.optional(Schema.Array(Schema.String)),
      profile: Schema.optional(Schema.String),
      home: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      cursor: Schema.optional(Schema.String),
      patchPath: Schema.optional(Schema.String),
      patch: Schema.optional(Schema.Array(Schema.Unknown)),
      mcpTypes: Schema.optional(Schema.Array(Schema.String)),
      compact: Schema.optional(Schema.Boolean),
      configId: Schema.optional(Schema.String),
      value: Schema.optional(Schema.String),
    }),
  ),
);
export const fixture = Effect.fn("DshTest.fixture")(function* (scenario = "ok") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dsh-test-" });
  const file = path.join(directory, "events.jsonl");
  const binaryPath = writeFakeCli({
    directory: path.join(directory, "DeepSeek Harness"),
    name: "dsh",
    source: yield* fs.readFileString(
      yield* path.fromFileUrl(new URL("./agent.fixture.mjs", import.meta.url)),
    ),
    env: { DSH_TEST_LOG: file, DSH_TEST_CASE: scenario },
  });
  yield* fs.writeFileString(file, "");
  const settings = decodeDshSettings({
    enabled: true,
    bridgeEnabled: false,
    binaryPath,
    profile: "test-acp",
  });
  const environment = { ...(yield* HostProcess.Environment), DSH_HOME: directory };
  return {
    directory,
    settings,
    environment,
    log: fs.readFileString(file).pipe(
      Effect.map((s) =>
        s
          .split("\n")
          .filter(Boolean)
          .map((line) => readLogEntry(line)),
      ),
    ),
  };
});
