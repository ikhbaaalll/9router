import { describe, expect, it } from "vitest";

import { buildCommandCodeQuotas } from "../../open-sse/services/usage/commandcode.js";

describe("command-code quota assembly", () => {
  const credits = { monthlyCredits: 10, purchasedCredits: 2, freeCredits: 0.5 };
  const windowLimits = {
    fiveHour: { used: 3, cap: 14, resetAt: 1789728815515 },
    weekly: { used: 0.25, cap: 35, resetAt: 0 },
    limited: true,
    exceeded: "weekly",
  };
  const sub = { planId: "individual-goat", currentPeriodEnd: "2026-09-17T10:20:05.000Z" };
  const summary = { totalCost: 4.2 };

  const quotas = buildCommandCodeQuotas(credits, windowLimits, summary, sub, sub.planId);

  it("exposes the rolling windows with remaining percentages", () => {
    expect(quotas.five_hour).toMatchObject({
      used: 3, total: 14, remaining: 11,
      remainingPercentage: 78.6, resetAt: expect.stringContaining("2026"),
    });
    expect(quotas.weekly).toMatchObject({ used: 0.25, total: 35, remaining: 34.75 });
  });

  it("counts every credit pool into one credits quota", () => {
    expect(quotas.credits).toMatchObject({
      used: 4.2, remaining: 12.5, total: 16.7, currency: "USD",
      grantedBalance: 10, toppedUpBalance: 2.5,
    });
  });

  it("survives missing windows (free / pre-cap accounts)", () => {
    const naked = buildCommandCodeQuotas({}, {}, null, null, null);
    expect(naked.five_hour).toBeUndefined();
    expect(naked.credits.remaining).toBe(0);
  });
});
