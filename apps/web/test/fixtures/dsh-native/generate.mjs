import * as NodeFSP from "node:fs/promises";
import { writeFakeCli } from "../../../../../packages/provider-testing/src/fakeCli.ts";
import * as TestProviderHost from "../../../../../packages/provider-testing/src/TestProviderHost.ts";
import { decodeDshSettings } from "../../../../../packages/provider-dsh/src/settings.ts";
import { DshDriver } from "../../../../../packages/provider-dsh/src/server/driver.ts";
import { nodeLayer } from "../../../../../packages/provider-dsh/src/server/testing/fixture.ts";
import { makeTurnInput } from "../../../../../apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

const source = await NodeFSP.readFile(new URL("agent.mjs", import.meta.url), "utf8");
const frames = await NodeFSP.readFile(new URL("frames.json", import.meta.url), "utf8");
const services = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
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
const events = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dsh-browser-fixture-" });
    const binaryPath = writeFakeCli({
      directory,
      name: "dsh",
      source,
      env: { T3_DSH_REPLAY: frames },
    });
    const instanceId = ProviderInstanceId.make("dsh");
    const instance = yield* DshDriver.create({
      instanceId,
      enabled: true,
      displayName: "DeepSeek Harness",
      config: decodeDshSettings({
        enabled: true,
        binaryPath,
        bridgeEnabled: false,
        profile: "browser-test",
      }),
      environment: [{ name: "DSH_HOME", value: directory, sensitive: false }],
    });
    const setup = {
      threadId: ThreadId.make("dsh-browser"),
      modelSelection: { instanceId, model: "default" },
      runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
        cwd: directory,
        runtimeMode: "approval-required",
        interactionMode: "default",
      }),
    };
    const session = yield* instance.orchestrationAdapter.openSession({
      ...setup,
      providerSessionId: ProviderSessionId.make("dsh-browser"),
    });
    const providerThread = yield* session.ensureThread(setup);
    yield* session.startTurn(
      makeTurnInput({ ...setup, providerThread, instanceId, now: yield* DateTime.now }),
    );
    return yield* session.events.pipe(
      Stream.takeUntil((e) => e.type === "turn.terminal"),
      Stream.runCollect,
    );
  }).pipe(Effect.scoped, Effect.provide(services), Effect.timeout("20 seconds")),
);
if (events.at(-1)?.status !== "completed") throw new Error("DSH replay did not complete");
const items = events.flatMap((event) => {
  if (event.type !== "turn_item.updated") return [];
  const { nativeItemRef, planId } = event.turnItem;
  const { ordinal, status, title, type, ...fields } = event.turnItem;
  const item = { ordinal, status, title, type };
  for (const key of ["input", "output", "exitCode", "toolName", "fileName", "diffStr", "steps"]) {
    if (Object.hasOwn(fields, key)) item[key] = fields[key];
  }
  return [
    { id: nativeItemRef.nativeId, ...item, ...(planId ? { planId: nativeItemRef.nativeId } : {}) },
  ];
});
const contextUsage = events.find(
  (e) => e.type === "provider_thread.updated" && e.providerThread.contextUsage,
)?.providerThread.contextUsage;
if (!items.length || !contextUsage) throw new Error("Missing DSH projection");
await NodeFSP.writeFile(
  new URL("projected.json", import.meta.url),
  JSON.stringify({ items, contextUsage }, null, 2) + "\n",
);
