import { describe, expect, it } from "vite-plus/test";
import { turnEndToStopReason } from "./codec.ts";
import { admitAcpPrompt } from "./content.ts";
import { AcpModelControl } from "./model-control.ts";
import type { AcpContentBlock, LlmRuntime } from "./host.js";

describe("DSH wire translation", () => {
  it("maps terminal reasons without conflating host abort and explicit cancellation", () => {
    expect(turnEndToStopReason({ kind: "completed" })).toBe("end_turn");
    expect(turnEndToStopReason({ kind: "aborted" })).toBe("end_turn");
    expect(turnEndToStopReason({ kind: "interrupted" })).toBe("cancelled");
    expect(turnEndToStopReason({ kind: "max-tokens" })).toBe("max_tokens");
  });
  const admit = (blocks: AcpContentBlock[]) =>
    admitAcpPrompt(
      { get: () => undefined, logger: { warn: () => {} } },
      undefined,
      blocks,
      true,
      new AbortController().signal,
    );
  it("combines adjacent text and quoted resource links in wire order", async () => {
    await expect(
      admit([
        { type: "text", text: "a" },
        { type: "resource_link", name: 'a"b', uri: "file:///a" },
        { type: "text", text: "b" },
      ]),
    ).resolves.toEqual([
      { type: "text", text: 'a\n[resource_link name="a\\"b" uri="file:///a"]\nb' },
    ]);
  });
  it("rejects empty text, unsupported content and noncanonical image bytes before admission", async () => {
    await expect(admit([{ type: "text", text: "  " }])).rejects.toThrow("empty prompt");
    await expect(admit([{ type: "audio" }])).rejects.toThrow("audio");
    await expect(admit([{ type: "image", mimeType: "image/png", data: "AB==" }])).rejects.toThrow(
      "canonical base64",
    );
  });
  it("round-trips opaque grouped routes and exposes dependent reasoning options", async () => {
    const llm: LlmRuntime = {
      listProviders: () => [
        { id: "demo", name: "Demo" },
        { id: "other", name: "Other" },
      ],
      listModels: async () => [
        { id: "a", name: "First" },
        { id: "b", name: "Second" },
      ],
      resolveCallConfig: async (s) => s,
      resolveModelInfo: async (provider, model) => {
        if (provider === "other" && model === "b") throw new Error("unavailable");
        if (provider === "other")
          return { reasoning: { defaultEffort: "high", efforts: [{ id: "high", name: "High" }] } };
        return model === "a" ? { reasoning: { efforts: [{ id: "low", name: "Low" }] } } : {};
      },
    };
    let selected = { provider: "demo", model: "a" };
    const control = new AcpModelControl(llm, {
      current: () => selected,
      select: (value) => {
        selected = value;
      },
    });
    const options = await control.options();
    const routes = options[0]?._meta?.["t3.dsh.modelReasoning"];
    expect(routes).toEqual({
      '["demo","a"]': options[1],
      '["demo","b"]': null,
      '["other","a"]': expect.objectContaining({
        currentValue: "high",
        options: [{ value: "high", name: "High" }],
      }),
    });
    expect(options).toMatchObject([
      { id: "model", currentValue: '["demo","a"]' },
      { id: "reasoning_effort", currentValue: "", options: [{ value: "" }, { value: "low" }] },
    ]);
    await expect(control.set("model", "unknown")).rejects.toThrow("unknown model");
    expect(await control.set("model", '["demo","b"]')).toMatchObject([
      { id: "model", currentValue: '["demo","b"]' },
    ]);
  });
});
