import {
  CustomModelSetting,
  TrimmedString,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "profile"],
  },
);
export type DshSettings = typeof DshSettings.Type;

export const decodeDshSettings = Schema.decodeSync(DshSettings);
