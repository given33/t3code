import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { drive, withWorkspace } from "./drive.mjs";
import { witnessUrl } from "./registry-witness.mjs";
import { answer, modelId, offlineProfile, startMock } from "./mock-llm.mjs";

await withWorkspace(async (root) => {
  const cwd = NodePath.join(root, "workspace");
  await NodeFSP.mkdir(cwd);
  const output = NodePath.join(root, "registry.json");
  let input;
  const mock = await startMock({
    textOnly: true,
    onModelInput: (messages) => {
      input = messages;
    },
  });
  try {
    const { variables, route } = await offlineProfile(root, true, mock, [
      {
        insert: [
          {
            id: "registry-witness",
            name: witnessUrl,
            config: { output },
          },
        ],
      },
    ]);
    await drive({
      bridgeEnabled: true,
      cwd,
      variables,
      profile: "acp",
      async run({ request, sessionId, configOptions, trace }) {
        NodeAssert.equal(
          configOptions.find((o) => o.id === "model")?.currentValue,
          JSON.stringify([route.provider, modelId]),
        );
        const update = trace.find(
          (m) =>
            m.params?.sessionId === sessionId &&
            m.params.update?.sessionUpdate === "available_commands_update",
        );
        NodeAssert.ok(update, "No session/new advertisement");
        const names = update.params.update.availableCommands.map((c) => c.name);
        const { resolved, skills } = JSON.parse(await NodeFSP.readFile(output, "utf8"));
        NodeAssert.ok(
          resolved.length && resolved.every(Boolean),
          "Unresolved command in DSH registry",
        );
        NodeAssert.ok(skills.length, "Expected skills in DSH profile");
        NodeAssert.deepEqual(names, [...resolved, ...skills.map((name) => `$${name}`)].sort());
        console.log(
          `Advertised: ${[...resolved.map((name) => `/${name}`), ...skills.map((name) => `$${name}`)].join(" ")}`,
        );
        console.log(`ctx.commands.list/find=${resolved.length}, ctx.skills.list=${skills.length}`);
        const known = resolved.includes("compact")
          ? "compact"
          : resolved.find(
              (name) => !update.params.update.availableCommands.find((c) => c.name === name)?.input,
            );
        NodeAssert.ok(known, "No argument-free command registered");
        const unknown = "/unknown-command-xyz";
        NodeAssert.ok(!resolved.includes(unknown.slice(1)));
        const skill = skills.includes("reverse-engineer-anything")
          ? "reverse-engineer-anything"
          : skills[0];
        const requests = mock.seen.get("Bearer offline-t3");
        for (const [line, count] of [
          [`/${known}`, 0],
          [unknown, 1],
          ["Hello again", 2],
          [`$${skill}`, 3],
        ]) {
          const start = trace.length;
          const { stopReason } = await request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: line }],
          });
          const updates = trace
            .slice(start)
            .filter((m) => m.method === "session/update")
            .map((m) => m.params.update);
          const chunks = updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
          const text = chunks.map((u) => u.content.text).join("");
          NodeAssert.equal(stopReason, "end_turn");
          NodeAssert.equal(requests.length, count);
          if (!count) {
            NodeAssert.equal(chunks.length, 1);
            NodeAssert.ok(text.trim());
            NodeAssert.ok(!updates.some((u) => u.sessionUpdate.startsWith("tool_call")));
          } else NodeAssert.equal(text, answer);
          if (count === 3) {
            const instructions = input
              .flatMap((m) =>
                Array.isArray(m.content) ? m.content.map((c) => c.text) : [m.content],
              )
              .find(
                (text) =>
                  typeof text === "string" &&
                  text.includes(`<skill_content name="${skill}">`) &&
                  text.includes("<skill_instructions>"),
              );
            NodeAssert.ok(instructions, "DSH did not inject the selected skill instructions");
            console.log(`Verified DSH skill injection: ${skill}`);
          }
          console.log(
            `${line}: stopReason=${stopReason}, mock requests=${count}, text=${JSON.stringify(text)}`,
          );
        }
        const advertisements = trace.filter(
          (m) =>
            m.params?.sessionId === sessionId &&
            m.params.update?.sessionUpdate === "available_commands_update",
        );
        NodeAssert.equal(advertisements.length, 2, "Missing commands/change advertisement");
        NodeAssert.deepEqual(advertisements[1].params.update, update.params.update);
        console.log("commands/change: active session re-advertised its registry");
      },
    });
    if (mock.failure) throw mock.failure;
  } catch (error) {
    throw mock.failure ?? error;
  } finally {
    await mock.close();
  }
});
