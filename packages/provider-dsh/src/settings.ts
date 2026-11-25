import {
  CustomModelSetting,
  TrimmedString,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const textSetting = (title: string, placeholder: string, value = "", description?: string) =>
  TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(value)),
    Schema.annotateKey({
      title,
      ...(description ? { description } : {}),
      providerSettingsForm: { placeholder, clearWhenEmpty: "omit" },
    }),
  );
const toggle = (title: string, description: string, value: boolean) =>
  Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(value)),
    Schema.annotateKey({ title, description, providerSettingsForm: { control: "switch" } }),
  );
export const DEFAULT_CUSTOM_KEY_ENV = "DEEPSEEK_CUSTOM_API_KEY";

export const DshSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("dsh").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the DeepSeek Harness (dsh) CLI binary.",
        providerSettingsForm: { placeholder: "dsh", clearWhenEmpty: "omit" },
      }),
    ),
    profile: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("acp")),
      Schema.annotateKey({
        title: "Profile",
        description: "DeepSeek Harness profile to launch for ACP sessions.",
        providerSettingsForm: { placeholder: "acp", clearWhenEmpty: "omit" },
      }),
    ),
    bridgeEnabled: toggle("T3 ACP bridge", "Run the T3 ACP plugin inside DeepSeek Harness.", true),
    syncLocalModels: toggle(
      "Sync local DSH models",
      "Load custom LLM providers and models configured in local DeepSeek Harness profiles (desktop/web).",
      true,
    ),
    customProviderId: textSetting("Custom provider ID", "custom"),
    customProviderBaseUrl: textSetting("Custom API base URL", "https://api.example.com/v1"),
    customProviderApi: Schema.Literals([
      "openai-responses",
      "openai-completions",
      "anthropic-messages",
    ]).pipe(
      Schema.withDecodingDefault(Effect.succeed("openai-responses" as const)),
      Schema.annotateKey({
        title: "Custom API protocol",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "openai-responses", label: "OpenAI Responses" },
            { value: "openai-completions", label: "OpenAI Chat Completions" },
            { value: "anthropic-messages", label: "Anthropic Messages" },
          ],
        },
      }),
    ),
    customProviderApiKeyEnv: textSetting(
      "Custom API key env",
      DEFAULT_CUSTOM_KEY_ENV,
      DEFAULT_CUSTOM_KEY_ENV,
    ),
    syncToLocalDsh: toggle(
      "Sync custom models to local DSH",
      "Write T3 custom provider and models into the local DeepSeek Harness profile patch so the CLI can reuse them.",
      false,
    ),
    instructionsHome: textSetting(
      "Role instructions directory",
      "~/dsh-role",
      "",
      "Optional. Directory containing AGENTS.md loaded as global role instructions for this T3 DSH instance without altering standalone DSH Desktop.",
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: [
      "binaryPath",
      "profile",
      "bridgeEnabled",
      "syncLocalModels",
      "customProviderId",
      "customProviderBaseUrl",
      "customProviderApi",
      "customProviderApiKeyEnv",
      "syncToLocalDsh",
      "instructionsHome",
    ],
  },
);
export type DshSettings = typeof DshSettings.Type;

export const decodeDshSettings = Schema.decodeSync(DshSettings);
