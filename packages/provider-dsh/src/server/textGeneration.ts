import { type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Operations from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { buildThreadTitlePrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import type { DshSettings } from "../settings.ts";
import { startDshToolFreeSession } from "./acpSupport.ts";
import { applyDshModelSelection } from "./adapter.ts";

const isTextGenerationError = Schema.is(TextGenerationError);
const operation = "generateThreadTitle";
const failure = (detail: string) => new TextGenerationError({ operation, detail });

export const makeDshTextGeneration = Effect.fn("Dsh.makeTextGeneration")(function* (
  settings: DshSettings,
  environment: NodeJS.ProcessEnv,
) {
  const runText = Effect.fn("Dsh.generateText")(function* (
    prompt: string,
    modelSelection: ModelSelection,
  ) {
    const { runtime, started } = yield* startDshToolFreeSession(settings, environment);
    const generate = Effect.gen(function* () {
      yield* applyDshModelSelection(runtime, modelSelection, undefined, settings);
      let text = "";
      yield* runtime.handleSessionUpdate(({ sessionId, update }) =>
        Effect.sync(() => {
          if (
            sessionId === started.sessionId &&
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text"
          )
            text += update.content.text;
        }),
      );
      const response = yield* runtime.prompt({ prompt: [{ type: "text", text: prompt }] });
      if (response.stopReason !== "end_turn" || !text.trim())
        return yield* failure(
          `DSH returned ${response.stopReason} with ${text.trim() ? "incomplete" : "empty"} text.`,
        );
      return text;
    });
    const close = runtime.closeSession(started.sessionId);
    const text = yield* generate.pipe(
      Effect.onError(() => close.pipe(Effect.ignore, Effect.timeoutOption("2 seconds"))),
    );
    yield* close;
    return text;
  }, Effect.scoped);
  const services = yield* Effect.context<Effect.Services<ReturnType<typeof runText>>>();
  const unsupported = (name: string) =>
    Effect.fail(
      new TextGenerationError({
        operation: name,
        detail: "DeepSeek Harness only supports thread title generation.",
      }),
    );
  return {
    generateThreadTitle: Effect.fn("Dsh.generateThreadTitle")(function* (input) {
      if (!settings.enabled) return yield* failure("DeepSeek Harness is disabled.");
      const { prompt, outputSchema } = buildThreadTitlePrompt(input);
      const text = yield* runText(prompt, input.modelSelection).pipe(
        Effect.provide(services),
        Effect.timeout("90 seconds"),
        Effect.mapError((err) =>
          isTextGenerationError(err)
            ? err
            : failure(
                err._tag === "TimeoutError"
                  ? "DeepSeek Harness title generation timed out after 90 seconds."
                  : `DeepSeek Harness title generation failed (${err._tag === "AcpRequestError" ? `${err.method ?? "ACP"} ${err.code}` : err._tag}).`,
              ),
        ),
      );
      const result = yield* Operations.decodeJsonReply(
        { operation, outputSchema },
        "DeepSeek Harness",
        text,
      );
      const title = yield* Operations.generatedThreadTitle(result.title);
      // The shared display sanitizer substitutes “New thread” for empty or quote-only input.
      if (title === "New thread" && !result.title.includes(title))
        return yield* failure("DeepSeek Harness returned an empty title.");
      return {
        title,
        ...(result.needsRefinement && { needsRefinement: true }),
      };
    }),
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
    generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
  } satisfies ProviderTextGeneration;
});
