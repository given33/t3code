import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeTimersPromises from "node:timers/promises";

export const modelId = "offline-responses";
export const fileName = "acp-fixture.txt";
export const fixture = "offline pwsh verified";
export const toolArgs = {
  description: "Read the offline ACP test fixture",
  command: `Get-Content -LiteralPath ${fileName}`,
};
export const answer = "Offline stream verified.";

export async function startMock() {
  const seen = new Map([
    ["Bearer offline-t3", []],
    ["Bearer offline-official", []],
  ]);
  let failure;
  const server = NodeHttp.createServer(async (req, res) => {
    try {
      NodeAssert.equal(req.url, "/v1/responses");
      NodeAssert.equal(req.method, "POST");
      const parts = [];
      for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      NodeAssert.equal(body.model, modelId);
      NodeAssert.equal(body.stream, true);
      const result = body.input.find((i) => i.type === "function_call_output");
      const tool = body.tools.find((t) => t.name === "pwsh");
      NodeAssert.ok(tool, `Missing pwsh (offered: ${body.tools.map((t) => t.name).join(", ")})`);
      if (result)
        NodeAssert.ok(
          JSON.stringify(result.output).includes(fixture),
          "Tool did not read the fixture",
        );
      const requests = seen.get(req.headers.authorization);
      NodeAssert.ok(requests, "Expected an isolated offline credential");
      requests.push(result ? "text" : "tool");
      NodeAssert.ok(requests.length <= 2, "Unexpected additional model request");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let sequence = 0;
      const send = (type, fields) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`,
        );
      const response = {
        id: "resp_offline",
        model: modelId,
        object: "response",
        status: "in_progress",
        output: [],
      };
      send("response.created", { response });
      const item = result
        ? { type: "message", id: "msg_offline", role: "assistant", content: [] }
        : {
            type: "function_call",
            id: "fc_offline",
            call_id: "call_offline",
            name: tool.name,
            arguments: "",
          };
      send("response.output_item.added", {
        output_index: 0,
        item: { ...item, status: "in_progress" },
      });
      const fields = { item_id: item.id, output_index: 0 };
      if (result) {
        const content = { type: "output_text", text: "", annotations: [] };
        send("response.content_part.added", { ...fields, content_index: 0, part: content });
        for (const delta of ["Offline stream ", "verified."]) {
          send("response.output_text.delta", { ...fields, content_index: 0, delta });
          await NodeTimersPromises.setImmediate();
        }
        content.text = answer;
        item.content.push(content);
        send("response.output_text.done", { ...fields, content_index: 0, text: answer });
        send("response.content_part.done", { ...fields, content_index: 0, part: content });
      } else {
        item.arguments = JSON.stringify(toolArgs);
        send("response.function_call_arguments.delta", { ...fields, delta: item.arguments });
        send("response.function_call_arguments.done", { ...fields, arguments: item.arguments });
      }
      item.status = "completed";
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", {
        response: {
          ...response,
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 },
        },
      });
      res.end();
    } catch (e) {
      failure ??= e;
      if (!res.headersSent) res.writeHead(400);
      res.end("Invalid offline test request");
    }
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    seen,
    get failure() {
      return failure;
    },
    async close() {
      const closed = NodeEvents.once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
