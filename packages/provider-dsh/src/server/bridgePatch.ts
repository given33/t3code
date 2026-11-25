// The ACP bundle owns this default independently of agent-default-model.
export function bridgePatch(
  url: string,
  config: Record<string, unknown> = { provider: "deepseek-official", model: "deepseek-v4-flash" },
) {
  return [{ id: "acp", disabled: true }, { insert: [{ id: "t3-acp-bridge", name: url, config }] }];
}
