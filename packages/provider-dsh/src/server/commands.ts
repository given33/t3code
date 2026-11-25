import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import type * as Acp from "effect-acp/compat";

export function dshCommandCatalog(commands: ReadonlyArray<Acp.AvailableCommand>) {
  const seen = new Set<string>();
  const slashCommands: ServerProviderSlashCommand[] = [];
  const skills: ServerProviderSkill[] = [];
  for (const command of commands) {
    const { name } = command;
    if (!name || name.length > 128 || name !== name.trim() || name === "$") continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const description = command.description.trim().slice(0, 1024);
    if (name.startsWith("$")) {
      const skill = name.slice(1);
      if (skill !== skill.trim()) continue;
      skills.push({
        name: skill,
        ...(description && { description }),
        path: `acp://skill/${encodeURIComponent(skill)}`,
        scope: "agent",
        enabled: true,
      });
    } else {
      const hint = command.input?.hint.trim().slice(0, 1024);
      slashCommands.push({
        name,
        ...(description && { description }),
        ...(hint && { input: { hint } }),
      });
    }
  }
  return { slashCommands, skills, slashCommandsPending: false };
}
