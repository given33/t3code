import * as NodeFSP from "node:fs/promises";

export const witnessUrl = import.meta.url;
export const name = "t3-registry-witness";
export const inject = ["commands", "skills"];

export function apply(ctx, { output }) {
  // Exercise the real event bus with the registry unchanged; no test command enters the catalog.
  ctx.on("session/event", (_session, event) => {
    if (event.type === "command/done") ctx.emit("commands/change");
  });
  ctx.on("agent/created", async ({ agent }) => {
    const commands = ctx.get("commands");
    const skills = ctx.get("skills");
    const resolved = commands.list(agent).map(({ name }) => commands.find(agent, name)?.name);
    const summaries = await skills.list({ scope: agent, cwd: agent.session.header.cwd });
    await NodeFSP.writeFile(
      output,
      JSON.stringify({ resolved, skills: summaries.map((s) => s.name) }),
    );
  });
}
