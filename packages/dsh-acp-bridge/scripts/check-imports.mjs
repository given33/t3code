import * as NodeFSP from "node:fs/promises";
import * as NodeVM from "node:vm";

const { readFile } = NodeFSP;

const entry = new URL("../dist/index.js", import.meta.url);
const compiled = new NodeVM.SourceTextModule(await readFile(entry, "utf8"));
const imports = compiled.moduleRequests.map((request) => request.specifier);
for (const specifier of imports) {
  if (!specifier.startsWith("node:"))
    throw new Error(`Unexpected static bridge import: ${specifier}`);
}
console.log(`Static imports: ${imports.join(", ")}. Forbidden imports: 0`);
