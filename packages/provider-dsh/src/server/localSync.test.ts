import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parseDocument } from "yaml";
import { decodeDshSettings } from "../settings.ts";
import { dshModels } from "./catalog.ts";
import { prepareDshOverlay } from "./localSync.ts";
import { nodeLayer } from "./testing/fixture.ts";

const decodeOverlay = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)));
const desktop = `# Desktop-owned profile
- id: ui-toolbar
  config: { visible: !!js process.env.DESKTOP_ONLY }
- id: mobile-link
  config: { enabled: true }
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      pixel:
        apiKeyEnv: PIXEL_API_KEY
        api: openai-responses
        baseURL: https://pixel.example/v1
        models: [{id: flash, name: Flash, input: [text, image], reasoningEfforts: {off: null, max: max}}]
- id: agent-default-model
  config: {provider: pixel, model: flash, reasoningEffort: max}
- id: llm-deepseek
  config: { models: [{id: vision}] }
- id: alternate-id
  name: '@deepseek-ai/dsh-llm-alternate'
  config: { models: [] }
`;
const harness = Effect.fn(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dsh-sync-test-" });
  const file = (profile: string) =>
    path.join(home, ".dsh", "profiles", profile, "cordis.patch.yml");
  const put = Effect.fn(function* (profile: string, text: string) {
    yield* fs.makeDirectory(path.dirname(file(profile)), { recursive: true });
    yield* fs.writeFileString(file(profile), text);
  });
  const prepare = (input: Parameters<typeof decodeDshSettings>[0]) =>
    prepareDshOverlay(decodeDshSettings(input), {}).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
    );
  const overlay = Effect.fn(function* (input: Parameters<typeof decodeDshSettings>[0]) {
    const result = yield* prepare(input);
    if (!result) return [];
    return yield* decodeOverlay(yield* fs.readFileString(result));
  });
  return { home, file, path, put, prepare, overlay, fs };
});
const custom = {
  customProviderId: "sample",
  customProviderBaseUrl: "https://sample.example/v1",
  customProviderApi: "anthropic-messages",
  customProviderApiKeyEnv: "SAMPLE_TOKEN",
  customModels: [
    "new",
    "sample/new",
    { slug: '["sample","new"]', name: "Named model" },
    "other/external",
  ],
} as const;
const provider = {
  apiKeyEnv: "SAMPLE_TOKEN",
  api: "anthropic-messages",
  baseURL: custom.customProviderBaseUrl,
  models: [{ id: "new", name: "Named model" }],
};
it.layer(nodeLayer)("DSH profile overlays", (it) => {
  it.effect("imports only model plugins, merging web, desktop and explicit profile overrides", () =>
    Effect.gen(function* () {
      const f = yield* harness();
      yield* f.put("desktop", desktop);
      yield* f.put(
        "web",
        `- id: llm-pi-ai\n  config: {providers: {web: {models: []}, pixel: {models: []}}}`,
      );
      const initial = yield* f.overlay({});
      expect(initial).toHaveLength(5);
      expect(initial).toContainEqual({ id: "acp", config: { provider: "pixel", model: "flash" } });
      expect(initial).toContainEqual({
        id: "agent-default-model",
        config: { provider: "pixel", model: "flash", reasoningEffort: "max" },
      });
      expect(initial).toContainEqual({
        id: "llm-deepseek",
        config: { models: [{ id: "vision" }] },
      });
      expect(initial).toContainEqual({
        id: "alternate-id",
        name: "@deepseek-ai/dsh-llm-alternate",
        config: { models: [] },
      });
      expect(initial[0]).toMatchObject({
        id: "llm-pi-ai",
        config: {
          providers: {
            web: { models: [] },
            pixel: {
              apiKeyEnv: "PIXEL_API_KEY",
              models: [{ input: ["text", "image"], reasoningEfforts: { off: null, max: "max" } }],
            },
          },
        },
      });
      expect(yield* f.fs.exists(f.file("acp"))).toBe(false);
      const active = `- id: llm-pi-ai\n  config: { extra: keep, providers: {pixel: {enabled: false}} }\n- id: agent-default-model\n  config: {model: active}\n- id: llm-deepseek\n  disabled: true`;
      yield* f.put("acp", active);
      const merged = yield* f.overlay(custom);
      expect(merged).toHaveLength(2);
      expect(merged[0]).toMatchObject({
        id: "llm-pi-ai",
        config: {
          extra: "keep",
          providers: { web: { models: [] }, pixel: { enabled: false }, sample: provider },
        },
      });
      expect(yield* f.fs.readFileString(f.file("acp"))).toBe(active);
      expect(yield* f.fs.readFileString(f.file("desktop"))).toBe(desktop);
    }),
  );
  it.effect("normalizes legacy DeepSeek model fields only in the runtime overlay", () =>
    Effect.gen(function* () {
      const f = yield* harness();
      const legacy = `- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    other: keep
    models:
      - {id: vision, imageMaxBytes: 1048576, imageDetail: high, input: [image]}
      - {id: both, imageTargetBytes: 256, imageMaxBytes: 128}
- id: account-alias
  name: '@deepseek-ai/dsh-llm-deepseek-account'
  config: {models: [{id: other, imageDetail: low}]}
- id: llm-unrelated
  config: {models: [{id: unchanged, imageMaxBytes: 64}]}`;
      yield* f.put("desktop", legacy);
      expect(yield* f.overlay({})).toEqual([
        {
          id: "llm-deepseek",
          name: "@deepseek-ai/dsh-llm-deepseek-api-key",
          config: {
            other: "keep",
            models: [
              { id: "vision", imageTargetBytes: 1048576, input: ["image"] },
              { id: "both", imageTargetBytes: 256 },
            ],
          },
        },
        {
          id: "account-alias",
          name: "@deepseek-ai/dsh-llm-deepseek-account",
          config: { models: [{ id: "other" }] },
        },
        { id: "llm-unrelated", config: { models: [{ id: "unchanged", imageMaxBytes: 64 }] } },
      ]);
      expect(yield* f.fs.readFileString(f.file("desktop"))).toBe(legacy);
      yield* f.put("acp", legacy);
      const active = yield* f.overlay({});
      expect(active).toHaveLength(2);
      expect(active[0]).toMatchObject({
        config: { models: [{ imageTargetBytes: 1048576 }, { imageTargetBytes: 256 }] },
      });
      expect(yield* f.fs.readFileString(f.file("acp"))).toBe(legacy);
    }),
  );
  it.effect(
    "uses the active default route but leaves an explicitly configured ACP plugin alone",
    () =>
      Effect.gen(function* () {
        const f = yield* harness();
        yield* f.put(
          "desktop",
          "- id: agent-default-model\n  config: {provider: inherited, model: old}",
        );
        const active = "- id: agent-default-model\n  config: {provider: local, model: selected}";
        yield* f.put("acp", active);
        expect(yield* f.overlay({})).toEqual([
          { id: "acp", config: { provider: "local", model: "selected" } },
        ]);
        const explicit = `${active}\n- id: acp\n  config: {provider: explicit, model: kept}`;
        yield* f.put("acp", explicit);
        expect(yield* f.overlay({})).toEqual([]);
        expect(yield* f.fs.readFileString(f.file("acp"))).toBe(explicit);
        yield* f.put("acp", `${active}\n  disabled: true`);
        expect(yield* f.overlay({})).toEqual([]);
      }),
  );
  it.effect(
    "ignores desktop/web when disabled and removes the private runtime overlay with its scope",
    () =>
      Effect.gen(function* () {
        const f = yield* harness();
        yield* f.put("desktop", "[invalid YAML");
        yield* f.put("web", "[also invalid");
        expect(yield* f.prepare({ syncLocalModels: false })).toBeUndefined();
        const file = yield* Effect.scoped(f.prepare({ ...custom, syncLocalModels: false }));
        expect(file).toBeDefined();
        expect(yield* f.fs.exists(file!)).toBe(false);
        expect(yield* f.fs.exists(f.file("acp"))).toBe(false);
        expect(
          yield* f.overlay({
            syncLocalModels: false,
            customProviderBaseUrl: custom.customProviderBaseUrl,
            customModels: ["bare"],
          }),
        ).toMatchObject([
          {
            config: {
              providers: {
                custom: {
                  apiKeyEnv: "DEEPSEEK_CUSTOM_API_KEY",
                  api: "openai-responses",
                  models: [{ id: "bare", name: "bare" }],
                },
              },
            },
          },
        ]);
      }),
  );
  it.effect(
    "writes only owned provider settings, preserves tagged YAML and is byte/mtime-idempotent",
    () =>
      Effect.gen(function* () {
        const f = yield* harness();
        yield* f.put("desktop", desktop);
        yield* f.put(
          "acp",
          `# keep this comment\n- id: agent-loop\n  config: { cwd: !!js process.cwd() }\n- id: llm-pi-ai\n  config:\n    providers:\n      other: {models: []}\n      sample: {models: [{id: kept, input: [image]}, {id: new, extra: !!js localSetting}]}\n`,
        );
        const inputs = { ...custom, syncToLocalDsh: true, instructionsHome: "~/role" };
        yield* f.overlay(inputs);
        const saved = yield* f.fs.readFileString(f.file("acp"));
        const stamp = (yield* f.fs.stat(f.file("acp"))).mtime;
        expect(saved).toContain("# keep this comment");
        expect(saved).toContain("!!js process.cwd()");
        expect(saved).toContain("!!js localSetting");
        expect(saved).not.toMatch(/agent-instructions|pixel|agent-default-model/u);
        const profile = parseDocument(saved, { logLevel: "silent" }).toJS();
        expect(profile).toMatchObject([
          { id: "agent-loop" },
          {
            id: "llm-pi-ai",
            config: {
              providers: {
                other: { models: [] },
                sample: {
                  ...provider,
                  models: [
                    { id: "kept", input: ["image"] },
                    { id: "new", name: "Named model", extra: "localSetting" },
                  ],
                },
              },
            },
          },
        ]);
        yield* f.overlay(inputs);
        expect((yield* f.fs.stat(f.file("acp"))).mtime).toEqual(stamp);
        expect(yield* f.fs.readFileString(f.file("acp"))).toBe(saved);
        yield* f.overlay({ ...inputs, profile: "desktop" });
        expect(yield* f.fs.readFileString(f.file("desktop"))).toBe(desktop);
        yield* f.put("new-profile", "# Empty profile\n");
        yield* f.overlay({ ...inputs, profile: "new-profile" });
        expect(parseDocument(yield* f.fs.readFileString(f.file("new-profile"))).toJS()).toEqual([
          { id: "llm-pi-ai", config: { providers: { sample: provider } } },
        ]);
      }),
  );
  it.effect("does not overwrite malformed profiles or escape the selected profile directory", () =>
    Effect.gen(function* () {
      const f = yield* harness();
      yield* f.put("acp", "not: a patch list");
      for (const profile of ["acp", "../desktop", "node_modules"])
        expect(
          yield* Effect.flip(f.prepare({ ...custom, profile, syncToLocalDsh: true })),
        ).toMatchObject({ _tag: "AcpRequestError" });
      expect(yield* f.fs.readFileString(f.file("acp"))).toBe("not: a patch list");
      expect(yield* f.fs.exists(f.file("desktop"))).toBe(false);
    }),
  );
  it.effect(
    "rejects redirected headers before writeback and leaves hard-linked Desktop files intact",
    () =>
      Effect.gen(function* () {
        const f = yield* harness();
        const text =
          "- id: llm-pi-ai\n  config: {providers: {sample: {baseURL: https://old.example, headers: {X-Test: fixture}}}}";
        yield* f.put("desktop", text);
        expect(yield* Effect.flip(f.prepare({ ...custom, syncToLocalDsh: true }))).toMatchObject({
          _tag: "AcpRequestError",
        });
        expect(yield* f.fs.exists(f.file("acp"))).toBe(false);
        yield* f.put("acp", text);
        yield* f.fs.remove(f.file("acp"));
        yield* f.fs.link(f.file("desktop"), f.file("acp"));
        yield* f.overlay({
          ...custom,
          customProviderBaseUrl: "https://old.example",
          syncToLocalDsh: true,
        });
        expect(yield* f.fs.readFileString(f.file("desktop"))).toBe(text);
        expect(yield* f.fs.readFileString(f.file("acp"))).not.toBe(text);
      }),
  );
  it.effect(
    "applies role instructions only to the overlay and retains the active loader limits",
    () =>
      Effect.gen(function* () {
        const f = yield* harness();
        expect(yield* f.overlay({ instructionsHome: "~/role" })).toEqual([
          {
            id: "agent-instructions",
            config: { dshHome: f.path.join(f.home, "role"), maxBytes: 65536 },
          },
        ]);
        yield* f.put(
          "acp",
          "- id: agent-instructions\n  config: {maxBytes: 900, projectRootMarkers: [.project]}",
        );
        expect(
          yield* f.overlay({ instructionsHome: "~/role/AGENTS.md", syncToLocalDsh: true }),
        ).toEqual([
          {
            id: "agent-instructions",
            config: {
              dshHome: f.path.join(f.home, "role"),
              maxBytes: 900,
              projectRootMarkers: [".project"],
            },
          },
        ]);
        expect(yield* f.fs.readFileString(f.file("acp"))).not.toContain("dshHome");
      }),
  );
  it("deduplicates shorthand, JSON and bare IDs against the ACP model while preserving labels", () => {
    const slug = '["sample","new"]';
    const models = dshModels(decodeDshSettings(custom), [
      {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: slug,
        options: [{ value: slug, name: "Native model" }],
      },
    ]);
    expect(models.map((m) => m.slug)).toEqual(["default", slug, '["other","external"]']);
    expect(models[1]).toMatchObject({ isCustom: false, isDefault: true, name: "Named model" });
  });
});
