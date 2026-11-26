import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { investigationUnsupported } from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import { makeDshTextGeneration } from "./textGeneration.ts";
import { fixture, nodeLayer } from "./testing/fixture.ts";

const setup = Effect.fn(function* (
  reply = "",
  {
    marker = "",
    stopReason = "end_turn",
    enabled = true,
  }: { marker?: string; stopReason?: string; enabled?: boolean } = {},
) {
  const f = yield* fixture("t3-bridge");
  const generation = yield* makeDshTextGeneration(
    { ...f.settings, bridgeEnabled: true, enabled },
    {
      ...f.environment,
      DSH_TEST_REPLY: reply,
      DSH_TEST_PROMPT_MARKER: marker,
      DSH_TEST_STOP_REASON: stopReason,
    },
  );
  return {
    generation,
    log: f.log,
    input: {
      cwd: f.directory,
      modelSelection: { instanceId: ProviderInstanceId.make("dsh"), model: "default" },
    },
  };
});

it.layer(nodeLayer)("DSH text generation", (it) => {
  it.effect(
    "generateCommitMessage sends the staged summary and returns the model subject and body",
    () =>
      Effect.gen(function* () {
        const stagedSummary = "M src/native-sessions.ts";
        const f = yield* setup(
          '{"subject":"Restore native sessions.","body":"  Keep session history.  "}',
          { marker: stagedSummary },
        );
        expect(
          yield* f.generation.generateCommitMessage({
            ...f.input,
            branch: "fix/resume",
            stagedSummary,
            stagedPatch: "+resume()",
          }),
        ).toEqual({ subject: "Restore native sessions", body: "Keep session history." });
        expect((yield* f.log).filter((entry) => entry.method === "session/prompt")).toMatchObject([
          { promptContainsMarker: true },
        ]);
      }),
  );
  it.effect("generatePrContent returns the model title and body", () =>
    Effect.gen(function* () {
      const f = yield* setup(
        '{"title":"Resume saved sessions","body":"  Restore history across restarts.  "}',
      );
      expect(
        yield* f.generation.generatePrContent({
          ...f.input,
          baseBranch: "main",
          headBranch: "fix/resume",
          commitSummary: "Restore sessions",
          diffSummary: "M sessions.ts",
          diffPatch: "+resume()",
        }),
      ).toEqual({ title: "Resume saved sessions", body: "Restore history across restarts." });
    }),
  );
  it.effect("generateBranchName sanitizes the model fragment and applies the branch prefix", () =>
    Effect.gen(function* () {
      const f = yield* setup('{"branch":" Résumé   Sessions!? "}');
      expect(
        yield* f.generation.generateBranchName({
          ...f.input,
          message: "Resume saved sessions",
          naming: { mode: "static", prefix: "fix", instructions: "" },
        }),
      ).toEqual({ branch: "fix/resume-sessions" });
    }),
  );
  it.effect(
    "generateTranscriptionPostProcessing requests structured text and returns the rewrite",
    () =>
      Effect.gen(function* () {
        const f = yield* setup('{"transcription":"Resume the session."}', {
          marker: '"transcription"',
        });
        expect(
          yield* f.generation.generateTranscriptionPostProcessing({
            ...f.input,
            prompt: "Uh, resume the session. Return only the cleaned transcript.",
          }),
        ).toEqual({ transcription: "Resume the session." });
        expect((yield* f.log).filter((entry) => entry.method === "session/prompt")).toMatchObject([
          { promptContainsMarker: true },
        ]);
      }),
  );
  it.effect("generateThreadTitle keeps title cleanup and needsRefinement", () =>
    Effect.gen(function* () {
      const f = yield* setup('{"title":"  Native   sessions ","needsRefinement":true}');
      expect(
        yield* f.generation.generateThreadTitle({ ...f.input, message: "Fix native sessions" }),
      ).toEqual({ title: "Native sessions", needsRefinement: true });
    }),
  );
  it.effect.each([
    ["invalid JSON", "not JSON", "end_turn", "invalid structured output"],
    ["empty text", "   ", "end_turn", "empty text"],
    ["incomplete output", '{"branch":"discard-me"}', "max_tokens", "max_tokens"],
  ] as const)(
    "generateBranchName rejects %s with the originating operation",
    ([, reply, stopReason, detail]) =>
      Effect.gen(function* () {
        const f = yield* setup(reply, { stopReason });
        const error = yield* Effect.flip(
          f.generation.generateBranchName({ ...f.input, message: "Resume" }),
        );
        expect(error).toMatchObject({
          _tag: "TextGenerationError",
          operation: "generateBranchName",
          detail: expect.stringContaining(detail),
        });
        expect((yield* f.log).filter((entry) => entry.method === "session/close")).toHaveLength(1);
      }),
  );
  it.effect("generateReviewGuide returns investigationUnsupported before starting a process", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const error = yield* Effect.flip(
        f.generation.generateReviewGuide({
          ...f.input,
          projectCwd: f.input.cwd,
          number: 1,
          title: "Resume",
          description: "Restore history",
          baseBranch: "main",
          baseCommit: "abc",
          settledReview: "",
        }),
      );
      expect(error).toMatchObject(
        investigationUnsupported("generateReviewGuide", "DeepSeek Harness"),
      );
      expect(yield* f.log).toEqual([]);
    }),
  );
  it.effect("reports a disabled provider before launching the branch generator", () =>
    Effect.gen(function* () {
      const f = yield* setup("", { enabled: false });
      const error = yield* Effect.flip(
        f.generation.generateBranchName({ ...f.input, message: "Resume" }),
      );
      expect(error).toMatchObject({
        _tag: "TextGenerationError",
        operation: "generateBranchName",
        detail: expect.stringContaining("disabled"),
      });
      expect(yield* f.log).toEqual([]);
    }),
  );
});
