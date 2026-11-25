import { expect, it } from "vite-plus/test";
import { acpTurnPrompt } from "./orchestrationInstructions.ts";

it.each([undefined, false, true])(
  "reinjectInstructionsEveryTurn=%s respects delivery state",
  (reinjectInstructionsEveryTurn) => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: true } as const;
    const input = { prompt: "continue", state, compacted: false, reinjectInstructionsEveryTurn };
    const first = acpTurnPrompt({ ...input, previousState: undefined });
    expect(first).toContain("<t3_code_instructions>");
    expect(first).toContain("T3 Code orchestration");
    const second = acpTurnPrompt({ ...input, previousState: state });
    if (reinjectInstructionsEveryTurn) {
      expect(second).toContain("<t3_code_instructions>");
      expect(second).toBe(first);
    } else {
      expect(second).toBe(input.prompt);
    }
    expect(acpTurnPrompt({ ...input, previousState: state, compacted: true })).toBe(first);
    expect(acpTurnPrompt({ ...input, previousState: state, prompt: "  /compact" })).toBe(
      "  /compact",
    );
  },
);
