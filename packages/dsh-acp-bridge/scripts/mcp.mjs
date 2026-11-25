import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import { drive, withWorkspace } from "./drive.mjs";
import { offlineProfile, startMock } from "./mock-llm.mjs";

await withWorkspace(async (cwd) => {
  const args = { text: "round-trip" };
  const expected = `echo:${args.text}`;
  const name = "mcp__fixture__echo";
  const calls = [];
  let failure;
  // Stateless Streamable HTTP: each request yields one JSON response. The
  // optional server-to-client event stream is unsupported (405).
  const server = NodeHttp.createServer(async (req, res) => {
    try {
      NodeAssert.equal(req.url, "/mcp");
      NodeAssert.equal(req.headers["x-fixture"], "t15");
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" }).end();
        return;
      }
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const { jsonrpc, id, method, params } = JSON.parse(Buffer.concat(body));
      NodeAssert.equal(jsonrpc, "2.0");
      if (id === undefined) {
        res.writeHead(202).end();
        return;
      }
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
                description: "Echo the provided text",
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
          calls.push(params);
          result = { content: [{ type: "text", text: `echo:${params.arguments.text}` }] };
          break;
        default:
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(
              JSON.stringify({ jsonrpc, id, error: { code: -32601, message: "Method not found" } }),
            );
          return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc, id, result }));
    } catch (error) {
      failure ??= error;
      res.writeHead(400).end();
    }
  });
  const mock = await startMock({
    toolCalls: [{ name, args }],
    onModelInput: (input) => {
      const output = input.find((item) => item.type === "function_call_output");
      if (output) NodeAssert.ok(JSON.stringify(output.output).includes(expected));
    },
  });
  try {
    server.listen(0, "127.0.0.1");
    await NodeEvents.once(server, "listening");
    const mcpServers = [
      {
        type: "http",
        name: "fixture",
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        headers: [{ name: "X-Fixture", value: "t15" }],
      },
    ];
    const { variables } = await offlineProfile(cwd, true, mock);
    await drive({
      bridgeEnabled: true,
      cwd,
      variables,
      profile: "acp",
      mcpServers,
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
        const [call, done] = frames.map((m) => m.params.update);
        NodeAssert.equal(call.sessionUpdate, "tool_call");
        NodeAssert.equal(call.title, name);
        NodeAssert.deepEqual(call.rawInput, args);
        NodeAssert.equal(done.sessionUpdate, "tool_call_update");
        NodeAssert.equal(done.toolCallId, call.toolCallId);
        NodeAssert.equal(done.status, "completed");
        NodeAssert.ok(done.content.some((c) => c.content?.text === expected));
        NodeAssert.deepEqual(
          calls.map((p) => [p.name, p.arguments]),
          [["echo", args]],
        );
        NodeAssert.deepEqual(mock.seen.get("Bearer offline-t3"), ["tool", "text"]);
      },
    });
    if (failure || mock.failure) throw failure ?? mock.failure;
  } catch (error) {
    throw failure ?? mock.failure ?? error;
  } finally {
    const closed = NodeEvents.once(server, "close");
    server.close();
    server.closeAllConnections();
    await Promise.all([closed, mock.close()]);
  }
});
