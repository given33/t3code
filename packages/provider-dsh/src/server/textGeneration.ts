import { TextGenerationError } from "@t3tools/contracts";
import * as Operations from "@t3tools/provider-core/server/textGenerationOperations";
import { sanitizeThreadTitle } from "@t3tools/provider-core/server/textGenerationUtils";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DshSettings } from "../settings.ts";
import { startDshToolFreeSession } from "./acpSupport.ts";
import { applyDshModelSelection } from "./adapter.ts";

const provider = "DeepSeek Harness";
const hasTitle = Schema.is(Schema.Struct({ title: Schema.String }));
const failure = (operation: Operations.Operation, reason: string) =>
  new TextGenerationError({ operation, detail: `${provider} ${operation}: ${reason}` });

export const makeDshTextGeneration = Effect.fn("Dsh.makeTextGeneration")(function* (
  settings: DshSettings,
  environment: NodeJS.ProcessEnv,
) {
  const runText = Effect.fn("Dsh.generateText")(function* ({
    operation,
    modelSelection,
    prompt,
  }: Pick<Operations.Request<Schema.Top>, "operation" | "modelSelection" | "prompt">) {
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
      // The speech prompt asks for just the transcript. ACP needs the result envelope in-band.
      const requestText =
        operation === "generateTranscriptionPostProcessing"
          ? `${prompt}\n\nReturn the cleaned transcript as a JSON object with one string field, "transcription".`
          : prompt;
      const response = yield* runtime.prompt({ prompt: [{ type: "text", text: requestText }] });
      if (response.stopReason !== "end_turn" || !text.trim())
        return yield* failure(
          operation,
          `returned ${response.stopReason} with ${text.trim() ? "incomplete" : "empty"} text.`,
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
  const runner: Operations.Runner = Effect.fn("Dsh.runStructuredText")(function* (request) {
    const { operation } = request;
    if (!settings.enabled) return yield* failure(operation, "provider is disabled.");
    const text = yield* runText(request).pipe(
      Effect.provide(services),
      Effect.timeout("90 seconds"),
      Effect.mapError((err) =>
        err._tag === "TextGenerationError"
          ? err
          : failure(
              operation,
              err._tag === "TimeoutError"
                ? "timed out after 90 seconds."
                : `request failed (${err._tag === "AcpRequestError" ? `${err.method ?? "ACP"} ${err.code}` : err._tag}).`,
            ),
      ),
    );
    const result = yield* Operations.decodeJsonReply(request, provider, text);
    // Reject a missing title before the shared display sanitizer substitutes its fallback.
    if (
      operation === "generateThreadTitle" &&
      hasTitle(result) &&
      sanitizeThreadTitle(result.title) === "New thread" &&
      !result.title.includes("New thread")
    )
      return yield* failure(operation, "returned an empty title.");
    return result;
  });
  return Operations.fromRunner(
    "DshTextGeneration",
    Operations.withoutInvestigation(provider, runner),
  );
});
