import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parseDocument } from "yaml";
import type { DshSettings } from "../settings.ts";
import { readDshSkillRoots } from "./localSync.ts";

const frontmatter = /^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/u;

const readSkill = Effect.fn("Dsh.readSkill")(function* (file: string, scope: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file);
  if (info.type !== "File" || info.size > 1024 * 1024) return;
  const header = frontmatter.exec(yield* fs.readFileString(file))?.[1];
  if (!header) return;
  const doc = parseDocument(header, { logLevel: "silent" });
  if (doc.errors.length) return;
  const name = doc.get("name");
  const description = doc.get("description");
  if (typeof name !== "string" || !name.trim()) return;
  return {
    name: name.trim(),
    ...(typeof description === "string" && description.trim()
      ? { description: description.trim() }
      : {}),
    path: file,
    scope,
    enabled: true,
  } satisfies ServerProviderSkill;
});

export const discoverDshSkills = Effect.fn("Dsh.discoverSkills")(function* (
  settings: DshSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots = yield* readDshSkillRoots(settings, environment, cwd);
  const seen = new Set<string>();
  const skills: ServerProviderSkill[] = [];
  for (const { directory, scope } of roots) {
    const canonical = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined));
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries.sort()) {
      const file = entry.toLowerCase().endsWith(".md")
        ? path.join(directory, entry)
        : path.join(directory, entry, "SKILL.md");
      const skill = yield* readSkill(file, scope).pipe(Effect.orElseSucceed(() => undefined));
      if (skill) skills.push(skill);
    }
  }
  return skills;
});
