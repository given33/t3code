// ACP v1 (DSH 0.2.3-alpha.2); synthetic provider/model/session IDs. No network or real DSH home.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const log = (entry) =>
  NodeFS.appendFileSync(process.env.DSH_TEST_LOG, `${JSON.stringify(entry)}\n`);
const args = process.argv.slice(2);
if (args[0] === "--version") {
  log({ method: "version" });
  process.stdout.write("0.2.3-alpha.2\n");
  process.exit(process.env.DSH_TEST_CASE === "bad-version" ? 1 : 0);
}
const patchPath = args[2] === "--patch" ? args[3] : undefined;
log({
  method: "launch",
  args,
  profile: args[1],
  home: process.env.DSH_HOME,
  ...(patchPath && { patchPath, patch: JSON.parse(NodeFS.readFileSync(patchPath, "utf8")) }),
});
const ids = [JSON.stringify(["alpha", "sample"]), JSON.stringify(["beta", "sample"])];
let model = ids[0];
let effort = "";
let pending;
const config = () => [
  {
    id: "model",
    category: "model",
    type: "select",
    name: "Model",
    currentValue: model,
    options: ids.map((value, i) => ({
      group: i ? "beta" : "alpha",
      name: i ? "Beta" : "Alpha",
      options: [{ value, name: "Sample" }],
    })),
  },
  {
    id: "reasoning_effort",
    category: "thought_level",
    type: "select",
    name: "Reasoning",
    currentValue: effort,
    options: ["", model === ids[0] ? "low" : "high"].map((value) => ({
      value,
      name: value || "Provider default",
    })),
  },
];
const send = (payload) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const { method, id, params } = JSON.parse(line);
  // Do not record environment variables, MCP headers, or prompt payloads.
  log({
    method,
    ...(method === "session/prompt" && { compact: params.prompt[0]?.text === "/compact" }),
    ...(params?.cwd && { cwd: params.cwd }),
    ...(params?.cursor && { cursor: params.cursor }),
    ...(params?.mcpServers && { mcpTypes: params.mcpServers.map((s) => s.type) }),
    ...(params?.configId && { configId: params.configId, value: params.value }),
  });
  switch (method) {
    case "initialize":
      send({
        id,
        result: {
          protocolVersion: 1,
          agentInfo: {
            name:
              process.env.DSH_TEST_CASE === "t3-bridge"
                ? "t3-deepseek-harness-acp"
                : "deepseek-harness-acp",
            version: "0.0.1",
          },
          agentCapabilities: {
            mcpCapabilities: { http: true },
            sessionCapabilities:
              process.env.DSH_TEST_CASE === "no-list" ? {} : { list: {}, resume: {}, close: {} },
          },
          authMethods: [],
        },
      });
      break;
    case "session/new":
      if (process.env.DSH_TEST_CASE === "probe-error")
        send({ id, error: { code: -32000, message: "Profile unavailable" } });
      else {
        if (process.env.DSH_TEST_CASE.startsWith("commands")) {
          const availableCommands = [{ name: "$guide", description: "ACP guide" }];
          if (process.env.DSH_TEST_CASE === "commands-compact")
            availableCommands.push({
              name: "compact",
              description: "Compact history",
              input: { hint: "focus" },
            });
          send({
            method: "session/update",
            params: {
              sessionId: "sample-session",
              update: { sessionUpdate: "available_commands_update", availableCommands },
            },
          });
        }
        send({ id, result: { sessionId: "sample-session", configOptions: config() } });
      }
      break;
    case "session/set_config_option":
      if (params.configId === "model" && ids.includes(params.value)) {
        model = params.value;
        effort = model === ids[0] ? "low" : "high";
      } else if (
        params.configId === "reasoning_effort" &&
        config()[1].options.some((o) => o.value === params.value)
      )
        effort = params.value;
      else {
        send({ id, error: { code: -32602, message: "Unknown value" } });
        break;
      }
      send({ id, result: { configOptions: config() } });
      break;
    case "session/list":
      send({
        id,
        result: {
          sessions: [{ sessionId: params.cursor ? "page-two" : "page-one", cwd: params.cwd }],
          nextCursor: params.cursor ? null : "next",
        },
      });
      break;
    case "session/close":
      send({ id, result: {} });
      break;
    case "session/prompt":
      if (params.prompt[0]?.text === "wait") pending = id;
      else if (params.prompt[0]?.text === "limit")
        send({ id, error: { code: -32000, message: "rate_limit: HTTP 429" } });
      else send({ id, result: { stopReason: "end_turn" } });
      break;
    case "session/cancel":
      if (pending !== undefined) {
        send({ id: pending, result: { stopReason: "cancelled" } });
        pending = undefined;
      }
      break;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: "Unsupported" } });
  }
}
