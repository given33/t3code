import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { DshDriver } from "../src/server/driver.ts";
import { decodeDshSettings } from "../src/settings.ts";
import { driverLayer, turnInput } from "../src/server/testing/turn.ts";

// Observe the consumer of the wire protocol. A second ordinary turn is a fence
// for queued events from the steered run; stopping at its first terminal hides duplicates.
export function checkSteerSettlement({ cwd, variables, streaming, release, steer }) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const instanceId = "dsh-steer";
      const driver = yield* DshDriver.create({
        instanceId,
        displayName: "DSH",
        enabled: true,
        config: decodeDshSettings({
          enabled: true,
          bridgeEnabled: true,
          binaryPath: process.env.T3_DSH_PARITY_CLI || "dsh",
        }),
        environment: variables,
      });
      const setup = {
        threadId: "steer-thread",
        modelSelection: { instanceId, model: "default" },
        runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
          cwd,
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
      };
      const session = yield* driver.orchestrationAdapter.openSession({
        ...setup,
        providerSessionId: "steer-session",
      });
      const { supportsActiveSteering, supportsSteeringByInterruptRestart } =
        session.providerSession.capabilities.turns;
      NodeAssert.deepEqual(
        [supportsActiveSteering, supportsSteeringByInterruptRestart],
        [true, true],
      );
      console.log(JSON.stringify({ supportsActiveSteering, supportsSteeringByInterruptRestart }));
      const providerThread = yield* session.ensureThread(setup);
      const input = yield* turnInput({ ...setup, providerThread }, 1, "Read the fixture.");
      const running = yield* Deferred.make();
      const firstTerminal = yield* Deferred.make();
      const secondTerminal = yield* Deferred.make();
      const terminals = [];
      yield* Stream.runForEach(session.events, (event) =>
        Effect.gen(function* () {
          if (
            event.type === "provider_turn.updated" &&
            event.providerTurn.ordinal === 1 &&
            event.providerTurn.status === "running"
          )
            yield* Deferred.succeed(running, event.providerTurn.id);
          if (event.type === "turn.terminal") {
            terminals.push(event);
            console.log(JSON.stringify(event));
            yield* Deferred.succeed(event.runOrdinal === 1 ? firstTerminal : secondTerminal, event);
          }
        }),
      ).pipe(Effect.forkChild);
      yield* session.startTurn(input);
      const providerTurnId = yield* Deferred.await(running);
      yield* Effect.promise(() => streaming.promise);
      yield* session.steerTurn({
        threadId: setup.threadId,
        providerThread,
        providerTurnId,
        runId: input.runId,
        message: { ...input.message, messageId: "steer-message", text: steer },
      });
      NodeAssert.equal(terminals.length, 0);
      release.resolve();
      NodeAssert.equal((yield* Deferred.await(firstTerminal)).status, "completed");
      yield* session.startTurn(
        yield* turnInput({ ...setup, providerThread }, 2, "Confirm the result."),
      );
      yield* Deferred.await(secondTerminal);
      NodeAssert.deepEqual(
        terminals.map(({ runOrdinal, status }) => [runOrdinal, status]),
        [
          [1, "completed"],
          [2, "completed"],
        ],
      );
    }).pipe(Effect.scoped, Effect.timeout("40 seconds"), Effect.provide(driverLayer)),
  );
}
