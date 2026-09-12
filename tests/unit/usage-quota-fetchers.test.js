import { describe, expect, it } from "vitest";

import { buildCommandCodeQuotas } from "../../open-sse/services/usage/commandcode.js";
import { buildClinepassQuotas } from "../../open-sse/services/usage/clinepass.js";

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

describe("clinepass window quotas", () => {
  const caps = {
    last5HoursUsageCostUSDPerUser: 1_000_000_000,
    last7daysUsageCostUSDPerUser: 2_500_000_000,
    last30daysUsageCostUSDPerUser: 5_000_000_000,
  };
  const now = Date.now();
  const item = (hoursAgo, costUsd) => ({
    createdAt: new Date(now - hoursAgo * 3600_000).toISOString(),
    costUsd,
  });
  const items = [
    item(1, 1_000_000),         // $1: inside 5h + 7d + 30d
    item(100, 2_000_000),       // $2: inside 7d + 30d only
    item(500, 4_000_000),       // $4: inside 30d only
    item(30 * 24 + 1, 8_000_000), // outside every window
  ];

  const quotas = buildClinepassQuotas(items, caps);

  it("sums cost within each sliding window and converts micro-USD", () => {
    expect(quotas["5h"].used).toBe(1);
    expect(quotas["7d"].used).toBe(3);
    expect(quotas["30d"].used).toBe(7);
  });

  it("computes remaining against the plan caps", () => {
    expect(quotas["5h"]).toMatchObject({ total: 1000, remaining: 999, remainingPercentage: 99.9 });
    expect(quotas["7d"].total).toBe(2500);
    expect(quotas["30d"].total).toBe(5000);
    expect(quotas["5h"].currency).toBe("USD");
    expect(quotas["5h"].resetAt).toBeNull();
  });

  it("skips windows the plan does not cap", () => {
    const partial = buildClinepassQuotas(items, { last7daysUsageCostUSDPerUser: 2_500_000_000 });
    expect(partial["5h"]).toBeUndefined();
    expect(partial["7d"]).toBeDefined();
    expect(partial["30d"]).toBeUndefined();
  });
});
