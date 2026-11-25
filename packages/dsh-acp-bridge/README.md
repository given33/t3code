# T3 ACP bridge for DeepSeek Harness

## Architecture

`provider-dsh` starts the installed DSH CLI with a temporary Cordis `--patch`. The overlay disables the profile's `acp` plugin and inserts `t3-acp-bridge` by absolute `file://` URL, carrying forward the ACP route configuration. A file URL lets the CLI load the plugin from outside its own package tree, including from paths with spaces. The installed harness still owns profiles, agents, tools, permissions and persistence. Replacing this one transport plugin avoids maintaining a fork of DSH.

The bridge uses `createRequire` anchored at `process.argv[1]`, the DSH CLI entry, to resolve the host's ACP SDK and DSH services. It imports those resolved modules inside the CLI process, using the same runtime and versions as the installed plugins. The bridge build rejects static imports of these runtime dependencies. See [the installed baseline](./BASELINE.md) for the reference build and service contracts.

## Protocol differences from the official bridge

| Surface             | T3 behavior                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commands and skills | Advertises the installed `/commands` and `$skills`, refreshes on registry changes, and routes invocations through DSH.                                         |
| Tools               | Uses the DSH presenter for kind and title, reports pending calls, resolves file locations against the session cwd, and converts DSH diffs to ACP diff blocks.  |
| Plans               | Maps `todo_write` snapshots to ACP plan entries with medium priority and clears the previous plan at turn start.                                               |
| Permissions         | Advertises DSH permission presets on new/resumed sessions and supports `session/set_mode` and `current_mode_update`.                                           |
| Compaction          | Projects DSH compaction lifecycle events to ACP `compaction_update` for the owning session.                                                                    |
| Context window      | Preserves parity with the official bridge. `usage_update.size` comes from `session.requestContext().contextWindow`, while `used` comes from DSH's token meter. |

## Development and distribution

For a source-based launch, first run `pnpm --filter @t3tools/dsh-acp-bridge build` from the repository root. `pnpm build` builds the bridge as a dependency of the server, then copies its entry to `apps/server/dist/dsh-acp-bridge/index.js` beside the server chunks. Ship that directory with `dist/bin.mjs`. The copy is required for a successful server build.

On Windows, if `pnpm build` prints `No packages matched the filter`, the default script shell passed through the single quotes in the root build script. In PowerShell, run `pnpm exec vp run --filter "./apps/*" build` to execute the same build graph.

`bridgeEnabled` defaults to `true`. With it enabled, an explicit `T3_DSH_BRIDGE_PATH` selects a plugin file. For example, set `$env:T3_DSH_BRIDGE_PATH = 'D:\plugins\dsh\index.js'` in PowerShell before starting the server. Without an override, the provider tries the copy beside the bundle, then `packages/dsh-acp-bridge/dist/index.js` relative to the provider source. A missing explicit override, or failure to find either default, produces a provider status warning listing the attempted paths and uses the official plugin. Set `bridgeEnabled` to `false` to select the official plugin directly.

## Verification scripts

Run `node packages/dsh-acp-bridge/scripts/<name>.mjs` from the repository root after building the bridge. The integration scripts require an installed DSH CLI. The tool fixtures use the Windows ACP profile with `pwsh`.

| Name               | What it checks                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel`           | Cancels a streaming prompt, checks the SSE disconnect and subsequent updates, and sends a fresh prompt on the same session.            |
| `mcp`              | Mounts a loopback Streamable HTTP MCP server and checks one tool request and its result end to end.                                    |
| `compaction`       | Compares durable compaction on both bridges, checks ACP updates, and verifies the model's context window and measured usage.           |
| `modes`            | Exercises mode advertisement, preset switching, invalid mode errors and resume against DSH.                                            |
| `tools`            | Drives real shell, read, write and todo tools and checks ACP locations, diffs and plan entries.                                        |
| `commands`         | Compares advertisements to the installed command/skill registries and checks dispatch and skill instruction delivery.                  |
| `parity`           | Runs a live prompt on each bridge and compares ordered ACP transcripts, then exercises the offline and compaction comparisons.         |
| `e2e-offline`      | Uses a loopback SSE model to exercise a real tool call, streamed output, list, close and resume on both bridges.                       |
| `raw-instructions` | Checks that bare ACP does not inject T3's instruction marker before or after compaction and preserves a caller-supplied control block. |

## Known limits

The reference official bridge emits neither ACP compaction updates nor permission modes. The MCP end-to-end check covers Streamable HTTP only. Stdio MCP and visual rendering in T3 clients still need end-to-end verification. The packaging instructions above apply to the server `dist` layout.
