import { describe, expect, it } from "vitest";
import {
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  parseQuotaData,
  trimHiddenQuotaKeys,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("provider quota visibility", () => {
  const data = {
    quotas: {
      "gemini-pro-agent": {
        displayName: "Gemini 3.1 Pro (High)",
        used: 200,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
        remainingPercentage: 80,
      },
      "claude-opus-4-6-thinking": {
        displayName: "Claude Opus 4.6 (Thinking)",
        used: 100,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
        remainingPercentage: 90,
      },
    },
  };

  it("groups Antigravity model quotas into Gemini and Claude families", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(quotas.map((q) => q.modelKey)).toEqual([
      "gemini",
      "claude",
    ]);
    expect(quotas[0].name).toBe("Gemini (Flash / Pro)");
    expect(quotas[1].name).toBe("Claude (Sonnet / Opus)");
  });

  it("shows all quotas by default and hides configured provider rows", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(filterQuotasByVisibility("antigravity", quotas, {})).toHaveLength(2);

    const visibility = {
      antigravity: { hidden: ["claude"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["claude"]);
  });

  it("trims stale or obsolete model keys", () => {
    const quotas = parseQuotaData("antigravity", data);
    const trimmed = trimHiddenQuotaKeys(["claude", "stale-model-xyz", "gemini-3.8-flash-low"], quotas);
    expect(trimmed).toEqual(["claude"]);

    const visibility = {
      antigravity: { hidden: ["claude", "stale-model-xyz"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["claude"]);
  });

  it("parses Command Code rolling windows and credits", () => {
    const quotas = parseQuotaData("commandcode", {
      plan: "Command Code · GOAT",
      quotas: {
        five_hour: { used: 3, total: 14, remainingPercentage: 78.6, displayName: "5-hour window" },
        weekly: { used: 1, total: 35, remainingPercentage: 97.1, displayName: "Weekly window" },
        credits: { used: 70, total: 71, remainingPercentage: 1.4, displayName: "Credits", currency: "USD" },
      },
    });
    expect(quotas.map((q) => q.name)).toEqual(["5-hour window", "Weekly window", "Credits"]);
    expect(quotas[2].remainingPercentage).toBe(1.4);
  });

  it("parses ClinePass sliding windows", () => {
    const quotas = parseQuotaData("clinepass", {
      plan: "Cline Pass (Annual)",
      quotas: {
        "5h": { used: 0.007, total: 1000, remainingPercentage: 100, displayName: "5-hour window" },
        "7d": { used: 115, total: 2500, remainingPercentage: 95.4, displayName: "7-day window" },
        "30d": { used: 147, total: 5000, remainingPercentage: 97.1, displayName: "30-day window" },
      },
    });
    expect(quotas).toHaveLength(3);
    expect(quotas[1]).toMatchObject({ name: "7-day window", used: 115, total: 2500 });
  });

  it("does not apply one provider hidden list to another provider", () => {
    const quotas = parseQuotaData("antigravity", data);
    const visibility = {
      codex: { hidden: ["gemini"] },
    };
    expect(filterQuotasByVisibility("antigravity", quotas, visibility)).toHaveLength(2);
  });
});
