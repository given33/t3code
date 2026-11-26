import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { withWorkspace, drive } from "./drive.mjs";
import { offlineProfile, startMock, modelId } from "./mock-llm.mjs";
import { generateTitle } from "../../provider-dsh/scripts/parity-launch.mjs";
const { randomUUID } = NodeCrypto;

await withWorkspace(async (cwd) => {
  const title = `Model title ${randomUUID().slice(0, 8)}`;
  const message = `Verify title isolation ${randomUUID()}`;
  const inputs = [];
  const mock = await startMock({
    textOnly: true,
    expectToolFree: true,
    onModelFrame: (frame) => {
      if (frame.type === "response.output_text.delta") console.log(JSON.stringify(frame));
    },
    maxTextRequests: 1,
    textChunks: ['{"title":', JSON.stringify(title) + "}"],
    onModelInput: (input) => inputs.push(input),
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
    const result = await generateTitle(settings, variables, {
      cwd,
      message,
      modelSelection: { instanceId: "dsh", model: JSON.stringify(["t3-offline", modelId]) },
    });
    if (mock.failure) throw mock.failure;
    NodeAssert.deepEqual(result, { title });
    NodeAssert.equal(inputs.length, 1);
    NodeAssert.ok(JSON.stringify(inputs[0]).includes(message));
    NodeAssert.ok(!JSON.stringify(inputs[0]).includes("<t3_code_instructions>"));
    console.log(
      "model request",
      JSON.stringify(inputs[0].filter((m) => JSON.stringify(m).includes(message))),
      "tools=[]",
    );
    console.log(
      "model response",
      JSON.stringify({ title }),
      "provider result",
      JSON.stringify(result),
    );
    NodeAssert.deepEqual(await snapshot(), before);
    console.log(
      `persistent DSH_HOME: ${before.length} files unchanged, including closed thread history`,
    );
  } finally {
    await mock.close();
  }
});
