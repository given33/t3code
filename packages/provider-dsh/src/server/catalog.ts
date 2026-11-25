import type { ServerProviderModel } from "@t3tools/contracts";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import { providerModelsFromSettings } from "@t3tools/provider-core/server/snapshotProbe";
import { createModelCapabilities } from "@t3tools/shared/model";
import type * as Acp from "effect-acp/compat";
import type { DshSettings } from "../settings.ts";

export const DSH_DEFAULT = "default";
export const modelOption = (config: ReadonlyArray<Acp.SessionConfigOption>) =>
  config.find((o) => o.type === "select" && o.id === "model" && o.category === "model");
const empty = createModelCapabilities({ optionDescriptors: [] });

export function dshModels(
  settings: DshSettings,
  config: ReadonlyArray<Acp.SessionConfigOption> = [],
  previous?: ReadonlyArray<ServerProviderModel>,
) {
  const model = modelOption(config);
  const current = model?.type === "select" ? model.currentValue : undefined;
  // A live selection belongs to a thread, not to the profile. Only a fresh probe establishes the default.
  const defaultId = previous
    ? previous.find((m) => m.isDefault && m.slug !== DSH_DEFAULT)?.slug
    : current;
  const choices =
    model?.type !== "select"
      ? []
      : model.options.flatMap((item) =>
          "value" in item
            ? [{ ...item, group: "" }]
            : item.options.map((o) => ({ ...o, group: item.name || item.groupId })),
        );
  const names = new Set<string>();
  const collisions = new Set<string>();
  for (const choice of choices) {
    if (names.has(choice.name)) collisions.add(choice.name);
    names.add(choice.name);
  }
  const capabilities = createModelCapabilities({
    optionDescriptors: acpProviderOptionDescriptors({
      configOptions: config.filter(
        (o) => o.id === "reasoning_effort" && o.category === "thought_level",
      ),
      modeState: undefined,
    }),
  });
  const known = new Map(previous?.map((m) => [m.slug, m.capabilities]));
  const models: Array<ServerProviderModel> = [
    {
      slug: DSH_DEFAULT,
      name: "Harness default",
      isCustom: false,
      capabilities:
        current && current === defaultId ? capabilities : (known.get(DSH_DEFAULT) ?? empty),
    },
  ];
  for (const choice of choices) {
    if (!choice.value || choice.value === DSH_DEFAULT) continue;
    models.push({
      slug: choice.value,
      name:
        collisions.has(choice.name) && choice.group
          ? `${choice.name} (${choice.group})`
          : choice.name || choice.value,
      isCustom: false,
      ...(choice.value === defaultId ? { isDefault: true } : {}),
      capabilities: choice.value === current ? capabilities : (known.get(choice.value) ?? empty),
    });
  }
  return providerModelsFromSettings(models, settings.customModels, empty);
}
