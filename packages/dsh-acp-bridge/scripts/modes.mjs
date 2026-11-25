import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { drive, withWorkspace } from "./drive.mjs";
import { answer, offlineProfile, startMock } from "./mock-llm.mjs";

await withWorkspace(async (root) => {
  const cwd = NodePath.join(root, "workspace");
  await NodeFSP.mkdir(cwd);
  const mock = await startMock({ textOnly: true });
  try {
    const { variables } = await offlineProfile(root, true, mock);
    const { trace } = await drive({
      bridgeEnabled: true,
      cwd,
      variables,
      profile: "acp",
      onResponse(method, frame) {
        if (method === "session/new" || method === "session/resume") {
          console.log(`${method} modes=${JSON.stringify(frame.result?.modes)}`);
        } else if (method === "session/set_mode" || method === "session/prompt") {
          console.log(`${method} ${JSON.stringify(frame)}`);
        }
      },
      async run({ request, sessionId, trace }) {
        async function prompt(text) {
          const start = trace.length;
          const response = await request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text }],
          });
          NodeAssert.equal(response.stopReason, "end_turn");
          const frames = trace
            .slice(start)
            .filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk");
          for (const frame of frames) console.log(`${text} ${JSON.stringify(frame)}`);
          return frames.map((m) => m.params.update.content.text).join("");
        }
        // Independent DSH read path: the built-in /permission command renders current() and names.
        async function inspect() {
          const status = /^current preset (.+?) \(available: (.*?)\)$/.exec(
            await prompt("/permission"),
          );
          NodeAssert.ok(status, "Unrecognized DSH permission status");
          return { current: status[1], names: status[2].split(", ") };
        }
        const updatesSince = (start) =>
          trace
            .slice(start)
            .filter(
              (m) =>
                m.method === "session/update" &&
                m.params.update.sessionUpdate === "current_mode_update",
            );
        const expectUpdate = (start, id) => {
          const frames = updatesSince(start);
          NodeAssert.deepEqual(
            frames.map((m) => m.params),
            [{ sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: id } }],
          );
          console.log(JSON.stringify(frames[0]));
        };
        const initial = trace.find((m) => m.method === "session/new").result.modes;
        const status = await inspect();
        const available = initial.availableModes.map((m) => m.id);
        console.log(
          `availableModes=${JSON.stringify(available)} permissionPresets.names=${JSON.stringify(status.names)}`,
        );
        NodeAssert.deepEqual(available, status.names);
        NodeAssert.equal(initial.currentModeId, status.current);
        const set = (modeId) => request("session/set_mode", { sessionId, modeId });
        if (status.current === "danger-full-access") await set("read-only");
        let start = trace.length;
        NodeAssert.deepEqual(await set("danger-full-access"), {});
        NodeAssert.equal((await inspect()).current, "danger-full-access");
        expectUpdate(start, "danger-full-access");
        start = trace.length;
        NodeAssert.deepEqual(await set("danger-full-access"), {});
        NodeAssert.deepEqual(updatesSince(start), []);
        start = trace.length;
        NodeAssert.equal(await prompt("/permission read-only"), "preset read-only");
        NodeAssert.equal((await inspect()).current, "read-only");
        expectUpdate(start, "read-only");
        for (const modeId of ["no-such-mode", "custom"]) {
          start = trace.length;
          await NodeAssert.rejects(set(modeId), { code: -32602 });
          NodeAssert.equal((await inspect()).current, "read-only");
          NodeAssert.deepEqual(updatesSince(start), []);
        }
        NodeAssert.deepEqual(mock.seen.get("Bearer offline-t3"), []);
        NodeAssert.equal(await prompt("Hello"), answer);
        NodeAssert.equal(mock.seen.get("Bearer offline-t3").length, 1);
      },
    });
    const modes = (method) => trace.find((m) => m.method === method).result.modes;
    NodeAssert.deepEqual(modes("session/resume"), {
      ...modes("session/new"),
      currentModeId: "read-only",
    });
    if (mock.failure) throw mock.failure;
  } finally {
    await mock.close();
  }
});
