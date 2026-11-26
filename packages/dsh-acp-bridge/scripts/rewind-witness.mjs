// Observe only ACP identity and adapter terminals in the isolated server. Never serialize
// session/new arguments (they include MCP credentials) or prompt contents.
import * as NodeFS from "node:fs";
import * as NodeInspectorPromises from "node:inspector/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const record = (frame) =>
  NodeFS.appendFileSync(process.env.T22_TRACE, JSON.stringify(frame) + "\n");
const agents = new Map();
globalThis.t22Init = (pid, name) => agents.set(pid, name);
globalThis.t22New = (pid, sessionId) =>
  record({ type: "session/new", sessionId, pid, agent: agents.get(pid) });
globalThis.t22Terminal = ({ type, runOrdinal, providerTurnId, status }) =>
  record({ type, runOrdinal, providerTurnId, status });
const session = new NodeInspectorPromises.Session();
session.connect();
await session.post("Debugger.enable");
const dist = NodePath.dirname(process.argv[1]);
const points = new Map([
  [
    "options.onInitialized?.(initializeResult)",
    "globalThis.t22Init(Number(child.pid), initializeResult.agentInfo?.name)",
  ],
  ["sessionId = created.sessionId;", "globalThis.t22New(Number(child.pid), created.sessionId)"],
  [
    'if (event.type !== "turn.terminal") return { event }',
    'event.type === "turn.terminal" && globalThis.t22Terminal(event)',
  ],
]);
for (const name of NodeFS.readdirSync(dist).filter((name) => /^runtimeLayer-.*\.mjs$/.test(name))) {
  const file = NodePath.join(dist, name);
  const lines = NodeFS.readFileSync(file, "utf8").split("\n");
  for (const [marker, observe] of points) {
    const lineNumber = lines.findIndex((line) => line.includes(marker));
    if (lineNumber < 0) continue;
    await session.post("Debugger.setBreakpointByUrl", {
      url: NodeURL.pathToFileURL(file).href,
      lineNumber,
      condition: `(${observe}, false)`,
    });
    points.delete(marker);
  }
}
if (points.size) throw Error(`Missing observation points in server build: ${[...points.keys()]}`);
