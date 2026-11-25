import {
  t3AcpPromptWithInstructions,
  type T3AcpInstructionState,
} from "@t3tools/provider-core/server/orchestrationInstructions";

export function acpTurnPrompt(input: {
  prompt: string;
  state: T3AcpInstructionState;
  previousState: T3AcpInstructionState | undefined;
  compacted: boolean;
  reinjectInstructionsEveryTurn?: boolean | undefined;
}) {
  return t3AcpPromptWithInstructions({
    prompt: input.prompt,
    state: input.state,
    ...(input.previousState === undefined || input.compacted || input.reinjectInstructionsEveryTurn
      ? {}
      : { previousState: input.previousState }),
  });
}
