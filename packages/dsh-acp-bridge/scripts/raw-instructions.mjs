import * as NodeAssert from "node:assert/strict";
import { drive, withWorkspace } from "./drive.mjs";
import { modelId, offlineProfile, startMock } from "./mock-llm.mjs";

export function checkRawInstructions() {
  return withWorkspace(async (cwd) => {
    const marker = "<t3_code_instructions>";
    const control = `${marker}\nKeep this caller-supplied block intact.\n</t3_code_instructions>`;
    const requests = [];
    const mock = await startMock({
      textOnly: true,
      maxTextRequests: 4,
      onModelInput(input) {
        const texts = input.flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : (message.content ?? []).flatMap((part) => part.text ?? []),
        );
        requests.push({
          hasMarker: texts.some((t) => t.includes(marker)),
          hasControl: texts.some((t) => t.includes(control)),
        });
      },
    });
    try {
      const { variables } = await offlineProfile(cwd, true, mock, [
        {
          id: "compaction-basic",
          config: {
            summarizationProvider: "t3-offline",
            summarizationModel: modelId,
            retainTokens: 1,
          },
        },
      ]);
      await drive({
        bridgeEnabled: true,
        cwd,
        variables,
        profile: "acp",
        async run({ request, sessionId, trace }) {
          const prompt = async (label, text, suppliedBlock = false) => {
            const before = requests.length;
            const response = await request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text }],
            });
            NodeAssert.equal(response.stopReason, "end_turn");
            NodeAssert.equal(requests.length, before + 1, label);
            const observed = requests[before];
            console.log(`T3 bare ACP ${label}: ${marker}=${observed.hasMarker}`);
            NodeAssert.deepEqual(
              observed,
              { hasMarker: suppliedBlock, hasControl: suppliedBlock },
              label,
            );
          };
          await prompt(
            "before compaction",
            "Remember this sequence: " + "ordinary history ".repeat(32),
          );
          await prompt("/compact", "/compact");
          NodeAssert.ok(
            trace.some(
              (m) =>
                m.method === "session/update" &&
                m.params.sessionId === sessionId &&
                m.params.update.sessionUpdate === "compaction_update" &&
                m.params.update.status === "completed",
            ),
          );
          await prompt("after compaction", "Continue the sequence.");
          await prompt("caller-supplied control", `${control}\n\nContinue.`, true);
        },
      });
    } catch (error) {
      throw mock.failure ?? error;
    } finally {
      await mock.close();
    }
  });
}
if (import.meta.main) await checkRawInstructions();
