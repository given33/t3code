import type {
  CustomModelEntry,
  ServerProviderModel,
  ServerProviderSubProvider,
} from "@t3tools/contracts";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import { providerModelsFromSettings } from "@t3tools/provider-core/server/snapshotProbe";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Acp from "effect-acp/compat";
import type { DshSettings } from "../settings.ts";

export const DSH_DEFAULT = "default";
const routeSchema = Schema.fromJsonString(
  Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString]),
);
const decodeRoute = Schema.decodeUnknownOption(routeSchema);
export const encodeRoute = Schema.encodeSync(routeSchema);
export function modelRoute(
  slug: string,
  settings: Pick<DshSettings, "customProviderBaseUrl" | "customProviderId">,
) {
  const value = slug.trim();
  if (!value || value === DSH_DEFAULT) return undefined;
  if (value.startsWith("[")) return Option.getOrUndefined(decodeRoute(value));
  const slash = value.indexOf("/");
  if (slash >= 0)
    return slash > 0 && slash < value.length - 1
      ? ([value.slice(0, slash), value.slice(slash + 1)] as const)
      : undefined;
  return settings.customProviderBaseUrl
    ? ([settings.customProviderId || "custom", value] as const)
    : undefined;
}

export const modelOption = (config: ReadonlyArray<Acp.SessionConfigOption>) =>
  config.find((o) => o.type === "select" && o.id === "model" && o.category === "model");
const empty = createModelCapabilities({ optionDescriptors: [] });

const builtInProviderNames = new Map([
  ["deepseek-official", "DeepSeek API"],
  ["deepseek-account", "DeepSeek Account"],
]);

type CatalogSettings = Omit<DshSettings, "customModels"> & {
  readonly customModels: ReadonlyArray<
    string | (CustomModelEntry & { readonly subProvider?: string })
  >;
};

export function dshCatalog(
  settings: CatalogSettings,
  config: ReadonlyArray<Acp.SessionConfigOption> = [],
  previousModels?: ReadonlyArray<ServerProviderModel>,
  previousSubProviders?: ReadonlyArray<ServerProviderSubProvider>,
) {
  const model = modelOption(config);
  const current = model?.type === "select" ? model.currentValue : undefined;
  // A live selection belongs to a thread, not to the profile. Only a fresh probe establishes the default.
  const defaultId = previousModels
    ? previousModels.find((m) => m.isDefault && m.slug !== DSH_DEFAULT)?.slug
    : current;
  const capabilities = createModelCapabilities({
    optionDescriptors: acpProviderOptionDescriptors({
      configOptions: config.filter(
        (o) => o.id === "reasoning_effort" && o.category === "thought_level",
      ),
      modeState: undefined,
    }),
  });
  const known = new Map(previousModels?.map((m) => [m.slug, m]));
  const providerNames = new Map<string, string>();
  const providerId = (slug: string) => modelRoute(slug, settings)?.[0].trim();
  for (const entry of settings.customModels) {
    if (typeof entry === "string" || !entry.subProvider) continue;
    const id = providerId(entry.slug);
    if (id) providerNames.set(id, entry.subProvider);
  }
  for (const model of known.values()) {
    const id = providerId(model.slug);
    if (id && model.subProvider) providerNames.set(id, model.subProvider);
  }
  const groups = new Map<string, ServerProviderSubProvider>();
  const models: Array<ServerProviderModel> = [
    {
      slug: DSH_DEFAULT,
      name: "Harness default",
      isCustom: false,
      capabilities:
        current && current === defaultId
          ? capabilities
          : (known.get(DSH_DEFAULT)?.capabilities ?? empty),
    },
  ];
  for (const item of model?.type === "select" ? model.options : []) {
    let group: string | undefined;
    if ("options" in item) {
      // ACP v1 sessions can still supply the wire key `group` instead of `groupId`.
      const id =
        item.groupId?.trim() ||
        ("group" in item && typeof item.group === "string" ? item.group.trim() : undefined);
      group = item.name?.trim() || id;
      if (group) {
        groups.set(group, { name: group });
        if (id) providerNames.set(id, group);
      }
    }
    for (const choice of "options" in item ? item.options : [item]) {
      if (!choice.value || choice.value === DSH_DEFAULT) continue;
      models.push({
        slug: choice.value,
        name: choice.name || choice.value,
        ...(group ? { subProvider: group } : {}),
        isCustom: false,
        ...(choice.value === defaultId ? { isDefault: true } : {}),
        capabilities:
          choice.value === current
            ? capabilities
            : (known.get(choice.value)?.capabilities ?? empty),
      });
    }
  }
  const discovered = new Set(models.map((m) => m.slug));
  const custom = new Map<string, CustomModelEntry>();
  for (const entry of settings.customModels) {
    const raw = typeof entry === "string" ? entry : entry.slug;
    const route = modelRoute(raw, settings);
    const slug = route ? encodeRoute(route) : raw;
    // Aliases share one row. Keep explicit names/capabilities, not a shorthand as a name override.
    custom.set(slug, {
      slug,
      ...(route && !discovered.has(slug) ? { name: route[1] } : {}),
      ...custom.get(slug),
      ...(typeof entry === "object" && entry.name ? { name: entry.name } : {}),
      ...(typeof entry === "object" && entry.capabilities
        ? { capabilities: entry.capabilities }
        : {}),
    });
  }
  const previousGroups = new Map(previousSubProviders?.map((group) => [group.name, group]));
  const merged = providerModelsFromSettings(models, [...custom.values()], empty).map((model) => {
    if (model.slug === DSH_DEFAULT || model.subProvider) return model;
    const id = providerId(model.slug);
    const name = id
      ? (providerNames.get(id) ?? builtInProviderNames.get(id) ?? id)
      : known.get(model.slug)?.subProvider;
    if (!name) return model;
    if (!groups.has(name)) groups.set(name, previousGroups.get(name) ?? { name });
    return { ...model, subProvider: name };
  });
  return { models: merged, subProviders: [...groups.values()] };
}

export function dshModels(
  settings: DshSettings,
  config: ReadonlyArray<Acp.SessionConfigOption> = [],
  previous?: ReadonlyArray<ServerProviderModel>,
) {
  return dshCatalog(settings, config, previous).models;
}
