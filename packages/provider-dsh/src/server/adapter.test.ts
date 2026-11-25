import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import type * as Acp from "effect-acp/compat";
import { AcpRequestError } from "effect-acp/errors";
import {
  dshApprovalOptions,
  dshPermissionDisposition,
  makeDshAcpRuntime,
  dshSessionModeForPolicy,
} from "./acpSupport.ts";
import {
  applyDshModelSelection,
  DshProviderCapabilitiesV2,
  dshFlavor,
  dshPromptFailure,
} from "./adapter.ts";
import { fixture, nodeLayer } from "./testing/fixture.ts";

const request: Acp.RequestPermissionRequest = {
  sessionId: "one",
  toolCall: { toolCallId: "call", kind: "other" },
  options: [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ],
};
describe("DeepSeek ACP policy", () => {
  it("offers one-time decisions, never persists full-access grants, and respects explicit sandbox restrictions", () => {
    expect(dshApprovalOptions(request)).toEqual([
      { decision: "accept", label: "Allow once" },
      { decision: "decline", label: "Deny" },
      { decision: "cancel", label: "Cancel" },
    ]);
    expect(dshPermissionDisposition({ cwd: null, runtimeMode: "approval-required" }, request)).toBe(
      "ask",
    );
    expect(dshPermissionDisposition({ cwd: null, runtimeMode: "full-access" }, request)).toBe(
      "allow",
    );
    expect(
      dshPermissionDisposition(
        { cwd: null, runtimeMode: "full-access", sandboxPolicy: { type: "readOnly" } },
        request,
      ),
    ).toBe("deny");
    const persistent = {
      ...request,
      options: [{ optionId: "save", name: "Always", kind: "allow_always" as const }],
    };
    expect(dshPermissionDisposition({ cwd: null, runtimeMode: "full-access" }, persistent)).toBe(
      "ask",
    );
    expect(dshApprovalOptions(persistent)).toEqual([{ decision: "cancel", label: "Cancel" }]);
  });
  it("uses T3 client policy for edits-only and respects explicit sandbox, approval and managed limits", () => {
    const edits = { cwd: null, runtimeMode: "auto-accept-edits" } as const;
    const modes = {
      currentModeId: "workspace-write",
      availableModes: [{ id: "danger-full-access", name: "Full" }],
    };
    const full = { cwd: null, runtimeMode: "full-access", interactionMode: "default" } as const;
    expect(
      dshPermissionDisposition(edits, {
        ...request,
        toolCall: { toolCallId: "edit", kind: "edit" },
      }),
    ).toBe("allow");
    expect(
      dshPermissionDisposition(edits, {
        ...request,
        toolCall: { toolCallId: "exec", kind: "execute" },
      }),
    ).toBe("ask");
    expect(dshSessionModeForPolicy({ ...full, sandboxPolicy: { type: "readOnly" } }, modes)).toBe(
      "read-only",
    );
    expect(dshSessionModeForPolicy({ ...full, approvalPolicy: "on-request" }, modes)).toBe(
      "workspace-write",
    );
    expect(
      dshSessionModeForPolicy({ ...full, runtimeMode: "auto", maxRuntimeMode: "auto" }, modes),
    ).toBe("workspace-write");
  });
  it("classifies ACP limit errors without labeling ordinary failures as limits", () => {
    for (const message of ["rate_limit", "quota exceeded", "quota_exceeded", "HTTP 429"])
      expect(dshPromptFailure(AcpRequestError.internalError(message)).class).toBe("usage_limit");
    expect(dshPromptFailure(AcpRequestError.invalidParams("Unavailable model"))).toMatchObject({
      class: "provider_error",
      message: "Unavailable model",
      code: "-32602",
    });
  });
});

it.layer(nodeLayer)("DeepSeek ACP adapter", (it) => {
  it.effect(
    "applies the response to a model write before reasoning; resets to the native default, never the sentinel",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const instanceId = ProviderInstanceId.make("sample");
        const flavor = dshFlavor({
          ...f,
          settings: {
            ...f.settings,
            customProviderId: "beta",
            customProviderBaseUrl: "https://example.test/v1",
            customModels: ["sample"],
          },
          services: yield* Effect.context<FileSystem.FileSystem | Path.Path>(),
          instanceId,
          selfInvocation: { command: "node", entrypoint: undefined },
        });
        expect(flavor.reinjectInstructionsEveryTurn).toBe(true);
        expect(flavor.mcpOverHttp).toBe(true);
        expect(DshProviderCapabilitiesV2).toMatchObject({
          sessions: { supportsModelSwitchInSession: true },
          tools: { supportsMcpTools: true },
          threads: { canForkThread: false, canForkFromTurn: false },
          turns: { supportsActiveSteering: false },
          checkpointing: { providerCanRollbackConversation: false },
        });
        const runtime = yield* makeDshAcpRuntime({
          ...f,
          cwd: f.directory,
          clientInfo: { name: "test", version: "1" },
          mcpServers: [],
          httpMcpServers: [
            { type: "http", name: "t3-code", url: "http://127.0.0.1:1/mcp", headers: [] },
          ],
        });
        const startResult = yield* runtime.start();
        const apply = flavor.applyModelSelection;
        if (!apply) throw new Error("missing model selection");
        const select = (model: string, effort?: string) =>
          apply({
            runtime,
            startResult,
            modelSelection: {
              instanceId,
              model,
              options: effort === undefined ? [] : [{ id: "reasoning_effort", value: effort }],
            },
          });
        const alpha = '["alpha","sample"]',
          beta = '["beta","sample"]';
        yield* select("default");
        yield* select("beta/sample", "_t3/empty");
        yield* select(beta, "low");
        yield* select("sample", "high");
        yield* select("default");
        expect((yield* f.log).find((e) => e.method === "session/new")?.mcpTypes).toEqual(["http"]);
        expect((yield* f.log).filter((e) => e.configId).map((e) => [e.configId, e.value])).toEqual([
          ["model", beta],
          ["reasoning_effort", ""],
          ["reasoning_effort", "high"],
          ["model", alpha],
        ]);
        const withoutEffort = {
          ...runtime,
          getConfigOptions: runtime.getConfigOptions.pipe(
            Effect.map((config) => config.filter((o) => o.id !== "reasoning_effort")),
          ),
        };
        yield* applyDshModelSelection(
          withoutEffort,
          { instanceId, model: alpha, options: [{ id: "reasoning_effort", value: "high" }] },
          alpha,
        );
        expect((yield* f.log).filter((e) => e.configId)).toHaveLength(4);
      }),
  );
  it.effect("settles a cancelled prompt and can prompt again after an ACP error", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const runtime = yield* makeDshAcpRuntime({
        ...f,
        cwd: f.directory,
        clientInfo: { name: "cancel-test", version: "1" },
      });
      yield* runtime.start();
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) =>
          event._tag === "EventStreamBarrier"
            ? Deferred.succeed(event.acknowledge, undefined)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      const prompt = (text: string) => ({ prompt: [{ type: "text" as const, text }] });
      const dispatched = yield* Deferred.make<void>();
      const pending = yield* runtime.prompt(prompt("wait"), { dispatched }).pipe(Effect.forkChild);
      yield* Deferred.await(dispatched);
      yield* runtime.cancel;
      expect(yield* Fiber.join(pending)).toMatchObject({ stopReason: "cancelled" });
      expect(dshPromptFailure(yield* Effect.flip(runtime.prompt(prompt("limit")))).class).toBe(
        "usage_limit",
      );
      expect(yield* runtime.prompt(prompt("ok"))).toMatchObject({ stopReason: "end_turn" });
      expect((yield* f.log).filter((e) => e.method === "session/new")).toHaveLength(1);
    }),
  );
});
