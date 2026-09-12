import { describe, expect, it } from "vitest";

import { normalizeComboModelId } from "../../scripts/lib/normalizeComboModelId.mjs";

// OmniRoute wrote effort variants as "model-max"; this fork dispatches "model(max)".
// Only the parenthesised form reaches upstream as the effort-reduced id, so the
// migration has to translate — without touching real ids that end in a level word.
describe("normalizeComboModelId", () => {
  it("translates the effort-suffixed ids the migrated combos use", () => {
    expect(normalizeComboModelId("opencode-go/deepseek-v4-flash-max")).toBe("opencode-go/deepseek-v4-flash(max)");
    expect(normalizeComboModelId("opencode-go/deepseek-v4-pro-max")).toBe("opencode-go/deepseek-v4-pro(max)");
    expect(normalizeComboModelId("codex/gpt-5.6-luna-max")).toBe("codex/gpt-5.6-luna(max)");
    expect(normalizeComboModelId("codex/gpt-5.6-sol-high")).toBe("codex/gpt-5.6-sol(high)");
    expect(normalizeComboModelId("codex/gpt-5.6-sol-medium")).toBe("codex/gpt-5.6-sol(medium)");
  });

  it("leaves a real id that ends in a level word alone", () => {
    // qwen3.8-max is the model's own name, not "qwen3.8 at max effort".
    expect(normalizeComboModelId("opencode-go/qwen3.8-max")).toBe("opencode-go/qwen3.8-max");
    expect(normalizeComboModelId("codex/gpt-5.6-sol")).toBe("codex/gpt-5.6-sol");
    expect(normalizeComboModelId("opencode-go/glm-5.3")).toBe("opencode-go/glm-5.3");
  });

  it("leaves providers with no registry list alone", () => {
    // A custom OpenAI-compatible node forwards whatever it is given.
    expect(normalizeComboModelId("openai-compatible-chat-abc/deepseek/deepseek-v4-flash-0731"))
      .toBe("openai-compatible-chat-abc/deepseek/deepseek-v4-flash-0731");
    expect(normalizeComboModelId("nvidia/deepseek-ai/deepseek-v4-flash")).toBe("nvidia/deepseek-ai/deepseek-v4-flash");
  });

  it("passes through anything that is not a provider-qualified string", () => {
    expect(normalizeComboModelId("")).toBe("");
    expect(normalizeComboModelId(null)).toBe(null);
    expect(normalizeComboModelId(undefined)).toBe(undefined);
  });
});
