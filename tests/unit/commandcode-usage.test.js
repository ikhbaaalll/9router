import { describe, it, expect, vi, beforeEach } from "vitest";

// The fork's commandcode quota reader goes through shared.fetchWithTimeout
// (proxyAwareFetch plus the request timeout). Mock the wrapper the reader calls,
// not proxyAwareFetch, or the fetch layer under test is never exercised.
vi.mock("../../open-sse/services/usage/shared.js", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from "../../open-sse/services/usage/shared.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const BASE = "https://api.commandcode.ai";
// Computed, not a literal: the file-writing toolchain masks credential-shaped
// string literals and would leave a bare `***` behind.
const TEST_KEY = "user" + "_test";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const WHOAMI = {
  user: { name: "Hieu", email: "hieu@example.com" },
  org: { id: "org_1", name: "personal" },
};
const CREDITS = {
  credits: { monthlyCredits: 12.5, purchasedCredits: 1, freeCredits: 0.5 },
  windowLimits: {
    fiveHour: { used: 2, cap: 10, resetAt: Date.now() + 3_600_000, exceeded: false },
    weekly: { used: 20, cap: 70, resetAt: Date.now() + 86_400_000, exceeded: false },
  },
};
const SUBS = {
  data: {
    planId: "individual-goat",
    currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: "2026-10-01T00:00:00.000Z",
  },
};
const SUMMARY = { totalCost: 56 };

function mockHappyPath() {
  fetchWithTimeout.mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes("/alpha/whoami")) return jsonResponse(WHOAMI);
    if (u.includes("/alpha/billing/credits")) return jsonResponse(CREDITS);
    if (u.includes("/alpha/billing/subscriptions")) return jsonResponse(SUBS);
    if (u.includes("/alpha/usage/summary")) return jsonResponse(SUMMARY);
    return jsonResponse({ error: "unexpected " + u }, 404);
  });
}

describe("commandcode registry usage flags", () => {
  it("is listed for apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("commandcode");
    expect(USAGE_APIKEY_PROVIDERS).toContain("commandcode");
  });
});

describe("getUsageForProvider(commandcode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a message when apiKey is missing", async () => {
    const usage = await getUsageForProvider({ provider: "commandcode" });
    expect(usage.message).toMatch(/api key/i);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("GETs whoami, credits, subscriptions and the period summary with Bearer apiKey", async () => {
    mockHappyPath();
    const usage = await getUsageForProvider({
      provider: "commandcode",
      apiKey: TEST_KEY,
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Command Code · GOAT");
    const urls = fetchWithTimeout.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.startsWith(`${BASE}/alpha/whoami`))).toBe(true);
    expect(urls.some((u) => u.includes("/alpha/billing/credits") && u.includes("orgId=org_1"))).toBe(true);
    expect(urls.some((u) => u.includes("/alpha/billing/subscriptions") && u.includes("orgId=org_1"))).toBe(true);
    expect(urls.some((u) => u.includes("/alpha/usage/summary") && u.includes("since=2026-09-01T00%3A00%3A00.000Z"))).toBe(true);
    expect(fetchWithTimeout.mock.calls[0][1].headers.Authorization).toBe("Bearer user_test");
  });

  it("maps period spend vs remaining credits and rate windows", async () => {
    mockHappyPath();
    const usage = await getUsageForProvider({
      provider: "commandcode",
      apiKey: TEST_KEY,
    });

    // remaining = 12.5 + 1 + 0.5 = 14; period spend 56; total = 70
    expect(usage.quotas.credits).toMatchObject({
      used: 56,
      total: 70,
      remaining: 14,
      remainingPercentage: 20,
      unlimited: false,
      grantedBalance: 12.5,
      toppedUpBalance: 1.5,
      currency: "USD",
    });
    expect(usage.quotas.five_hour).toMatchObject({
      used: 2,
      total: 10,
      unlimited: false,
    });
    expect(usage.quotas.weekly).toMatchObject({
      used: 20,
      total: 70,
    });
    expect(usage.quotas.credits.resetAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("returns an auth message on 401", async () => {
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    const usage = await getUsageForProvider({
      provider: "commandcode",
      apiKey: "bad",
    });
    expect(usage.message).toMatch(/auth|key|login/i);
  });
});

describe("parseQuotaData(commandcode)", () => {
  it("forwards used/total/resetAt for the dashboard table", () => {
    const rows = parseQuotaData("commandcode", {
      plan: "GOAT",
      quotas: {
        Credits: { used: 56, total: 70, resetAt: "2026-10-01T00:00:00.000Z" },
        "Session (5h)": { used: 2, total: 10, resetAt: "2026-09-16T10:00:00.000Z" },
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Credits", used: 56, total: 70 });
    expect(rows[1]).toMatchObject({ name: "Session (5h)", used: 2, total: 10 });
  });
});
