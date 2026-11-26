// Loaded only by the isolated audit server. Never serialize MCP headers or URL queries.
import * as NodeInspectorPromises from "node:inspector/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const { Session } = NodeInspectorPromises;
const { readdirSync, readFileSync, appendFileSync } = NodeFS;
const { pathToFileURL } = NodeURL;
const dist = NodePath.dirname(process.argv[1]);
const debuggerSession = new Session();
debuggerSession.connect();
await debuggerSession.post("Debugger.enable");
globalThis.t20ObserveNew = ({ mcpServers }) => {
  const servers = mcpServers.map(({ name, type, url }) => ({
    name,
    type,
    origin: url && new URL(url).origin,
  }));
  appendFileSync(process.env.T20_NEW_LOG, JSON.stringify(servers) + "\n");
};
let matches = 0;
for (const file of readdirSync(dist).filter((name) => /^runtimeLayer-.*\.mjs$/.test(name))) {
  const source = readFileSync(NodePath.join(dist, file), "utf8").split("\n");
  const lineNumber = source.findIndex((line) =>
    line.includes("acp.agent.createSession(createPayload)"),
  );
  if (lineNumber < 0) continue;
  await debuggerSession.post("Debugger.setBreakpointByUrl", {
    url: pathToFileURL(NodePath.join(dist, file)).href,
    lineNumber,
    condition: "(globalThis.t20ObserveNew(createPayload), false)",
  });
  matches++;
}
if (!matches) throw Error("Build lacks session/new observation point. Rebuild the pinned source.");
