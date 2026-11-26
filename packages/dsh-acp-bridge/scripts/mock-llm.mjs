import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
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

export async function offlineProfile(
  root,
  bridgeEnabled,
  mock,
  extraPatch = [],
  modelOptions = {},
) {
  const home = NodePath.join(root, bridgeEnabled ? "t3" : "official");
  const profile = NodePath.join(home, "profiles", "acp");
  await NodeFSP.mkdir(profile, { recursive: true });
  const route = { provider: "t3-offline", model: modelId };
  // The base profile already registers pi-ai. Replace it to avoid duplicate adapter declarations.
  const patch = [
    { id: "llm-pi-ai", disabled: true },
    {
      insert: [
        {
          id: "offline-model",
          name: "@deepseek-ai/dsh-llm-pi-ai",
          config: {
            providers: {
              [route.provider]: {
                api: "openai-responses",
                apiKeyEnv: "T3_OFFLINE_KEY",
                baseURL: mock.url,
                models: [{ id: modelId, name: "Offline", ...modelOptions }],
              },
            },
          },
        },
      ],
    },
    { id: "agent-default-model", config: route },
    { id: "acp", config: route },
  ];
  await NodeFSP.writeFile(
    NodePath.join(profile, "cordis.patch.yml"),
    JSON.stringify([...patch, ...extraPatch]),
  );
  const variables = [
    { name: "DSH_HOME", value: home },
    { name: "DSH_TELEMETRY_DISABLED", value: "1" },
    { name: "T3_OFFLINE_KEY", value: bridgeEnabled ? "offline-t3" : "offline-official" },
  ];
  return { variables, route };
}

export async function startMock({
  textOnly = false,
  onModelInput,
  toolCalls,
  onTextStart,
  onToolStart,
  onModelFrame,
  expectToolFree = false,
  textChunks = ["Offline stream ", "verified."],
  maxTextRequests = 3,
} = {}) {
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
      onModelInput?.(body.input, body.tools);
      const requests = seen.get(req.headers.authorization);
      NodeAssert.ok(requests, "Expected an isolated offline credential");
      const step = requests.length;
      const results = body.input.filter((i) => i.type === "function_call_output");
      const calls = toolCalls ?? [{ name: "pwsh", args: toolArgs }];
      const call = textOnly ? undefined : calls[step];
      if (!textOnly) {
        NodeAssert.equal(results.length, step, "Expected a result for each previous tool call");
        if (!toolCalls && step === 1)
          NodeAssert.ok(
            JSON.stringify(results[0].output).includes(fixture),
            "Tool did not read the fixture",
          );
      }
      const expectedName = call?.name ?? "pwsh";
      if (expectToolFree) NodeAssert.deepEqual(body.tools ?? [], []);
      else
        NodeAssert.ok(
          body.tools.some((t) => t.name === expectedName),
          `Missing ${expectedName} (offered: ${body.tools.map((t) => t.name).join(", ")})`,
        );
      const replyWithText = !call;
      requests.push(replyWithText ? "text" : "tool");
      NodeAssert.ok(
        requests.length <= (textOnly ? maxTextRequests : calls.length + 1),
        "Unexpected additional model request",
      );
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let sequence = 0;
      const send = (type, fields) => {
        const frame = { type, sequence_number: sequence++, ...fields };
        onModelFrame?.(frame);
        return res.write(`event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`);
      };
      const response = {
        id: "resp_offline",
        model: modelId,
        object: "response",
        status: "in_progress",
        output: [],
      };
      send("response.created", { response });
      const item = replyWithText
        ? { type: "message", id: "msg_offline", role: "assistant", content: [] }
        : {
            type: "function_call",
            id: `fc_offline_${step}`,
            call_id: `call_offline_${step}`,
            name: call.name,
            arguments: "",
          };
      send("response.output_item.added", {
        output_index: 0,
        item: { ...item, status: "in_progress" },
      });
      const fields = { item_id: item.id, output_index: 0 };
      if (replyWithText) {
        const content = { type: "output_text", text: "", annotations: [] };
        send("response.content_part.added", { ...fields, content_index: 0, part: content });
        if (onTextStart) {
          await onTextStart({ step, res });
          if (res.destroyed) return;
        }
        const chunks = typeof textChunks === "function" ? textChunks(step) : textChunks;
        for (const delta of chunks) {
          send("response.output_text.delta", { ...fields, content_index: 0, delta });
          await NodeTimersPromises.setImmediate();
        }
        content.text = chunks.join("");
        item.content.push(content);
        send("response.output_text.done", { ...fields, content_index: 0, text: content.text });
        send("response.content_part.done", { ...fields, content_index: 0, part: content });
      } else {
        item.arguments = JSON.stringify(call.args);
        send("response.function_call_arguments.delta", { ...fields, delta: item.arguments });
        await onToolStart?.();
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
