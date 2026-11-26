import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { withWorkspace, drive } from "./drive.mjs";
import { offlineProfile, startMock, modelId } from "./mock-llm.mjs";
import { investigationUnsupported } from "../../provider-core/src/server/textGenerationOperations.ts";
import { withDshTextGeneration } from "../../provider-dsh/scripts/parity-launch.mjs";
const { randomUUID } = NodeCrypto;

await withWorkspace(async (cwd) => {
  const tag = randomUUID().slice(0, 8);
  const cases = [
    {
      operation: "generateCommitMessage",
      marker: `M resume-${tag}.ts`,
      input: { branch: "main", stagedSummary: `M resume-${tag}.ts`, stagedPatch: "+resume()" },
      reply: { subject: `Restore sessions ${tag}.`, body: "  Persist history.  " },
      expected: { subject: `Restore sessions ${tag}`, body: "Persist history." },
    },
    {
      operation: "generatePrContent",
      marker: `Resume history ${tag}`,
      input: {
        baseBranch: "main",
        headBranch: "fix/resume",
        commitSummary: `Resume history ${tag}`,
        diffSummary: "M history.ts",
        diffPatch: "+resume()",
      },
      reply: { title: `Restore history ${tag}`, body: "Reopen the previous session." },
    },
    {
      operation: "generateBranchName",
      marker: `Fix resume ${tag}`,
      input: { message: `Fix resume ${tag}` },
      reply: { branch: ` Resume   Sessions ${tag}!? ` },
      expected: { branch: `resume-sessions-${tag}` },
    },
    {
      operation: "generateThreadTitle",
      marker: `Verify title isolation ${tag}`,
      input: { message: `Verify title isolation ${tag}` },
      reply: { title: `Model title ${tag}` },
    },
    {
      operation: "generateTranscriptionPostProcessing",
      marker: `um resume ${tag}`,
      input: { prompt: `Clean up: um resume ${tag}. Return only the cleaned transcript.` },
      reply: { transcription: `Resume ${tag}.` },
    },
  ];
  const requests = [];
  const mock = await startMock({
    textOnly: true,
    expectToolFree: true,
    maxTextRequests: cases.length,
    onModelInput: (input, tools) => requests.push({ input, tools }),
    textChunks: (step) => {
      const json = JSON.stringify(cases[step].reply);
      const split = json.indexOf(":") + 1;
      return [json.slice(0, split), json.slice(split)];
    },
    onModelFrame: (frame) => {
      if (frame.type === "response.output_text.delta") console.log(JSON.stringify(frame));
    },
  });
  try {
    const { variables } = await offlineProfile(cwd, true, mock);
    const home = variables.find((v) => v.name === "DSH_HOME").value;
    // Keep a real closed thread in the persistent profile as a positive control.
    await drive({ bridgeEnabled: true, cwd, variables, run: async () => {} });
    const snapshot = async () => {
      const files = (await NodeFSP.readdir(home, { recursive: true, withFileTypes: true })).filter(
        (f) => f.isFile(),
      );
      return Promise.all(
        files
          .sort((a, b) =>
            NodePath.join(a.parentPath, a.name).localeCompare(NodePath.join(b.parentPath, b.name)),
          )
          .map(async (f) => {
            const file = NodePath.join(f.parentPath, f.name);
            return [
              NodePath.relative(home, file),
              (await NodeFSP.readFile(file)).toString("base64"),
            ];
          }),
      );
    };
    const before = await snapshot();
    NodeAssert.ok(
      before.some(([file]) => file.endsWith("session.v4.jsonl.zstd")),
      "missing persisted control thread",
    );
    const settings = {
      enabled: true,
      bridgeEnabled: true,
      binaryPath: process.env.T3_DSH_PARITY_CLI || "dsh",
    };
    const modelSelection = { instanceId: "dsh", model: JSON.stringify(["t3-offline", modelId]) };
    await withDshTextGeneration(settings, variables, async (generate) => {
      for (const [i, { operation, marker, input, reply, expected }] of cases.entries()) {
        const result = await generate(operation, { cwd, modelSelection, ...input });
        if (mock.failure) throw mock.failure;
        NodeAssert.deepEqual(result, expected ?? reply);
        NodeAssert.equal(requests.length, i + 1);
        const request = requests[i];
        const messages = request.input.filter((message) =>
          JSON.stringify(message).includes(marker),
        );
        NodeAssert.ok(messages.length > 0, `${operation}: model did not receive the input`);
        NodeAssert.ok(!JSON.stringify(request.input).includes("<t3_code_instructions>"));
        NodeAssert.deepEqual(request.tools ?? [], []);
        console.log(
          operation,
          "model request",
          JSON.stringify(messages),
          "tools=" + JSON.stringify(request.tools ?? []),
        );
        console.log(operation, "provider result", JSON.stringify(result));
        NodeAssert.deepEqual(await snapshot(), before);
        console.log(
          `${operation}: persistent DSH_HOME: ${before.length} files unchanged, including closed thread history`,
        );
      }
      const expected = investigationUnsupported("generateReviewGuide", "DeepSeek Harness");
      await NodeAssert.rejects(
        generate("generateReviewGuide", {
          cwd,
          projectCwd: cwd,
          modelSelection,
          number: 1,
          title: "Resume",
          description: "Restore history",
          baseBranch: "main",
          baseCommit: "abc",
          settledReview: "",
        }),
        (error) => {
          NodeAssert.equal(error._tag, expected._tag);
          NodeAssert.equal(error.operation, expected.operation);
          NodeAssert.equal(error.detail, expected.detail);
          console.log(error.operation, error._tag, error.detail);
          return true;
        },
      );
      NodeAssert.equal(requests.length, cases.length);
      NodeAssert.deepEqual(await snapshot(), before);
    });
  } finally {
    await mock.close();
  }
});
