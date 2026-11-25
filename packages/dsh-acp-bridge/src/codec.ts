import type { StopReason, TurnEndReason } from "./host.js";
/** Pure translation between the harness lifecycle and the automation-only ACP wire. */

/** Map a harness turn ending to ACP's terminal reason vocabulary. */
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case "completed":
      return "end_turn";
    case "max-tokens":
      return "max_tokens";
    // `cancelled` is reserved for explicit client cancellation (`session/cancel`)
    // and disposal, both settled out of band; a turn aborted by a hook or
    // another owner is ordinary quiescence and reports `end_turn`.
    case "aborted":
      return "end_turn";
    case "interrupted":
      return "cancelled";
    case "blocked":
    case "error":
      return "end_turn";

    default:
      return "end_turn";
  }
}
