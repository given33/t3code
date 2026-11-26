import * as NodeAssert from "node:assert/strict";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

// This file is also the child executable. Only protocol frames go to its stdout.
if (process.argv[2] === "--serve") {
  for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
    const { jsonrpc, id, method, params } = JSON.parse(line);
    NodeAssert.equal(jsonrpc, "2.0");
    if (id === undefined) continue;
    let result;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        };
        break;
      case "tools/list":
        result = {
          tools: [
            {
              name: "echo",
              description: "Echo text with the fixture prefix",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        };
        break;
      case "tools/call":
        NodeAssert.equal(params.name, "echo");
        result = {
          content: [
            { type: "text", text: `${process.env.T3_STDIO_PREFIX}:${params.arguments.text}` },
          ],
        };
        break;
      default:
        console.log(
          JSON.stringify({ jsonrpc, id, error: { code: -32601, message: "Method not found" } }),
        );
        continue;
    }
    console.log(JSON.stringify({ jsonrpc, id, result }));
  }
} else {
  const { drive, withWorkspace } = await import("./drive.mjs");
  const { offlineProfile, startMock } = await import("./mock-llm.mjs");
  await withWorkspace(async (cwd) => {
    const name = "mcp__fixture__echo";
    const args = { text: "round-trip" };
    const expected = "stdio-echo:round-trip";
    let modelSawResult = false;
    const mock = await startMock({
      toolCalls: [{ name, args }],
      onModelInput(input) {
        const output = input.find((item) => item.type === "function_call_output");
        if (output) {
          NodeAssert.ok(JSON.stringify(output.output).includes(expected));
          modelSawResult = true;
        }
      },
    });
    try {
      const { variables } = await offlineProfile(cwd, true, mock);
      await drive({
        bridgeEnabled: true,
        cwd,
        variables,
        profile: "acp",
        mcpServers: [
          {
            name: "fixture",
            command: process.execPath,
            args: [NodeURL.fileURLToPath(import.meta.url), "--serve"],
            env: [{ name: "T3_STDIO_PREFIX", value: "stdio-echo" }],
          },
        ],
        allowPermission: (call) => call?.title === name && call.rawInput?.text === args.text,
        async run({ request, sessionId, trace }) {
          console.log(JSON.stringify(trace.find((m) => m.request === "session/new")));
          const result = await request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "Use the echo tool" }],
          });
          NodeAssert.equal(result.stopReason, "end_turn");
          const frames = trace.filter(
            (m) =>
              m.params?.sessionId === sessionId &&
              ["tool_call", "tool_call_update"].includes(m.params.update?.sessionUpdate),
          );
          for (const frame of frames) console.log(JSON.stringify(frame));
          NodeAssert.equal(frames.length, 2);
          const [call, done] = frames.map((f) => f.params.update);
          NodeAssert.equal(call.sessionUpdate, "tool_call");
          NodeAssert.equal(call.title, name);
          NodeAssert.deepEqual(call.rawInput, args);
          NodeAssert.equal(done.sessionUpdate, "tool_call_update");
          NodeAssert.equal(done.toolCallId, call.toolCallId);
          NodeAssert.equal(done.status, "completed");
          NodeAssert.ok(done.content.some((c) => c.content?.text === expected));
          NodeAssert.ok(modelSawResult);
          NodeAssert.deepEqual(mock.seen.get("Bearer offline-t3"), ["tool", "text"]);
        },
      });
      if (mock.failure) throw mock.failure;
    } catch (error) {
      throw mock.failure ?? error;
    } finally {
      await mock.close();
    }
  });
}
