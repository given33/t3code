import * as NodeReadline from "node:readline";

if (process.argv[2] === "--version") {
  console.log("0.2.3-alpha.2");
  process.exit(0);
}
const send = (payload) => console.log(JSON.stringify({ jsonrpc: "2.0", ...payload }));
for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const { method, params, id } = JSON.parse(line);
  if (id === undefined) continue;
  switch (method) {
    case "initialize":
      send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
      break;
    case "session/new":
      send({ id, result: { sessionId: "browser-replay" } });
      break;
    case "session/prompt":
      for (const update of JSON.parse(process.env.T3_DSH_REPLAY)) {
        send({ method: "session/update", params: { sessionId: params.sessionId, update } });
      }
      send({ id, result: { stopReason: "end_turn" } });
      break;
    default:
      send({ id, error: { code: -32601, message: `Unsupported replay method ${method}` } });
  }
}
