import { MessageId, NodeId, ProjectId, RunAttemptId, RunId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nodeLayer } from "./fixture.ts";

export const driverLayer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
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
export const turnInput = Effect.fn(function* (
  {
    threadId,
    modelSelection,
    runtimePolicy,
    providerThread,
  }: Pick<
    ProviderAdapterV2TurnInput,
    "threadId" | "modelSelection" | "runtimePolicy" | "providerThread"
  >,
  ordinal: number,
  text: string,
) {
  const now = yield* DateTime.now;
  return {
    threadId,
    modelSelection,
    runtimePolicy,
    providerThread,
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    rootNodeId: NodeId.make(`root-${ordinal}`),
    runId: RunId.make(`run-${ordinal}`),
    attemptId: RunAttemptId.make(`attempt-${ordinal}`),
    message: {
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${ordinal}`),
    },
    appThread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "DSH test thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: runtimePolicy.runtimeMode,
      interactionMode: runtimePolicy.interactionMode,
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
  } satisfies ProviderAdapterV2TurnInput;
});
