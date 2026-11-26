import { expect, it } from "@effect/vitest";
import type { SessionConfigOption, SessionConfigSelectOptions } from "effect-acp/compat";
import { decodeDshSettings } from "../settings.ts";
import { dshCatalog, encodeRoute } from "./catalog.ts";

const modelConfig = (options: SessionConfigSelectOptions): SessionConfigOption[] => [
  {
    id: "model",
    type: "select",
    category: "model",
    name: "Model",
    currentValue: official,
    options,
  },
];
const official = encodeRoute(["deepseek-official", "flash"]);
const account = encodeRoute(["deepseek-account", "deepseek-flash"]);
const pixel = encodeRoute(["pixel", "deepseek-v4.1-flash"]);
const choice = (value: string) => ({ value, name: "DeepSeek-V4.1-Flash" });

it("keeps ACP group order and labels, then appends new route providers once", () => {
  const settings = decodeDshSettings({
    customProviderBaseUrl: "https://example.test/v1",
    customProviderId: "openai",
    customModels: [
      "pixel/extra",
      "account-alias/extra",
      "model-bare",
      '["custom","extra"]',
      "openai/model-bare",
    ],
  });
  const catalog = dshCatalog(
    settings,
    modelConfig([
      { groupId: "deepseek-official", name: " DeepSeek API ", options: [choice(official)] },
      { groupId: "deepseek-account", name: "DeepSeek Account", options: [choice(account)] },
      { groupId: " pixel ", name: "  ", options: [choice(pixel)] },
      { groupId: "account-alias", name: "DeepSeek Account", options: [] },
    ]),
  );
  expect(catalog.subProviders.map((g) => g.name)).toEqual([
    "DeepSeek API",
    "DeepSeek Account",
    "pixel",
    "openai",
    "custom",
  ]);
  expect(catalog.models.map((m) => [m.slug, m.subProvider])).toEqual([
    ["default", undefined],
    [official, "DeepSeek API"],
    [account, "DeepSeek Account"],
    [pixel, "pixel"],
    ['["pixel","extra"]', "pixel"],
    ['["account-alias","extra"]', "DeepSeek Account"],
    ['["openai","model-bare"]', "openai"],
    ['["custom","extra"]', "custom"],
  ]);
  expect(catalog.models.slice(1, 4).map((m) => m.name)).toEqual(
    Array(3).fill("DeepSeek-V4.1-Flash"),
  );
});

it("labels routes without ACP from built-in IDs and uses the default custom ID for bare names", () => {
  const settings = decodeDshSettings({
    customProviderBaseUrl: "https://example.test/v1",
    customModels: [official, "deepseek-account/deepseek-flash", "sample"],
  });
  const catalog = dshCatalog(settings);
  expect(catalog.models.map((m) => [m.slug, m.subProvider])).toEqual([
    ["default", undefined],
    [official, "DeepSeek API"],
    [account, "DeepSeek Account"],
    ['["custom","sample"]', "custom"],
  ]);
  expect(catalog.subProviders.map((g) => g.name)).toEqual([
    "DeepSeek API",
    "DeepSeek Account",
    "custom",
  ]);
});

it("uses fresh ACP names and keeps previous route labels only for groups still referenced", () => {
  const settings = decodeDshSettings({ customModels: ["pixel/extra"] });
  const previous = dshCatalog(
    settings,
    modelConfig([
      { groupId: "deepseek-official", name: "Old API", options: [choice(official)] },
      { groupId: "deepseek-account", name: "Removed Account", options: [choice(account)] },
      { groupId: "pixel", name: "Pixel Labs", options: [choice(pixel)] },
    ]),
  );
  const live = dshCatalog(
    settings,
    modelConfig([{ groupId: "deepseek-official", name: "New API", options: [choice(official)] }]),
    previous.models,
    previous.subProviders,
  );
  expect(live.subProviders).toEqual([{ name: "New API" }, { name: "Pixel Labs" }]);
  expect(live.models.map((m) => [m.slug, m.subProvider])).toEqual([
    ["default", undefined],
    [official, "New API"],
    ['["pixel","extra"]', "Pixel Labs"],
  ]);
});

it("keeps default attached to its profile route across model switches and clears unsupported capabilities", () => {
  const settings = decodeDshSettings({});
  const model = modelConfig([choice(official), choice(account), choice(pixel)])[0]!;
  const effort = (value: string) =>
    ({
      id: "reasoning_effort",
      type: "select",
      category: "thought_level",
      name: "Reasoning",
      currentValue: value,
      options: [{ value, name: value }],
    }) as const;
  const capabilities = { [official]: effort("low"), [account]: effort("high"), [pixel]: null };
  const config = (currentValue: string) => [
    {
      ...model,
      type: "select" as const,
      options: [choice(official), choice(account), choice(pixel)],
      currentValue,
      _meta: { "t3.dsh.modelReasoning": capabilities },
    },
  ];
  const initial = dshCatalog(settings, config(official));
  const switched = dshCatalog(settings, config(account), initial.models);
  expect(
    switched.models.map((m) => m.capabilities?.optionDescriptors?.map((o) => o.currentValue)),
  ).toEqual([["low"], ["low"], ["high"], []]);
  const oldBridge = dshCatalog(settings, [model, effort("low")]);
  expect(oldBridge.models.map((m) => m.capabilities?.optionDescriptors?.length)).toEqual([
    1, 1, 0, 0,
  ]);
});
