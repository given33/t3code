import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import type { DshRuntime } from "./host.js";

const { createRequire } = NodeModule;
const { pathToFileURL } = NodeURL;

let loaded: DshRuntime | undefined;
export function dshRuntime(): DshRuntime {
  if (!loaded) throw new Error("T3 DSH bridge runtime has not been loaded");
  return loaded;
}
export async function loadDshRuntime(): Promise<DshRuntime> {
  if (loaded) return loaded;
  const entry = process.argv[1];
  if (!entry) throw new Error("Cannot load T3 DSH bridge: process.argv[1] is missing");
  const require = createRequire(pathToFileURL(entry));
  async function fromHost<T>(specifier: string): Promise<T> {
    try {
      return (await import(pathToFileURL(require.resolve(specifier)).href)) as T;
    } catch (cause) {
      throw new Error(`Cannot load ${specifier} from DSH CLI argv[1]=${entry}`, { cause });
    }
  }
  const runtime: DshRuntime = {
    sdk: await fromHost("@agentclientprotocol/sdk"),
    schema: await fromHost("@deepseek-ai/schemastery"),
    brand: await fromHost("@deepseek-ai/dsh-brand"),
    llm: await fromHost("@deepseek-ai/dsh-llm"),
    agent: await fromHost("@deepseek-ai/dsh-agent"),
    attachment: await fromHost("@deepseek-ai/dsh-attachment"),
    mcp: await fromHost("@deepseek-ai/dsh-mcp-client"),
  };
  loaded = runtime;
  return runtime;
}
