/**
 * Command Code (commandcode.ai) usage — monthly credit pool + 5h/weekly rolling
 * windows, from the same /alpha endpoints the CommandCode CLI /usage view uses:
 *   GET /alpha/whoami                → org id (optional)
 *   GET /alpha/billing/credits       → credits pools + windowLimits
 *   GET /alpha/billing/subscriptions → planId + billing period
 *   GET /alpha/usage/summary         → period spend
 *
 * Ported from OmniRoute's usage/command-code.ts (2026-09-12), shapes verified
 * live against the migrated GOAT account.
 */

import { fetchWithTimeout, parseResetTime, toFiniteNumber } from "./shared.js";

const COMMAND_CODE_API_BASE = "https://api.commandcode.ai";

function withCurrency(quota, displayName) {
  return { ...quota, currency: "USD", displayName };
}

function humanizePlanId(planId) {
  if (!planId) return "Command Code";
  const labels = {
    "individual-goat": "GOAT",
    "individual-go": "Go",
    "individual-pro": "Pro",
    "individual-max-10x": "Max 10×",
    "individual-max-20x": "Max 20×",
    "team-pro": "Team Pro",
  };
  const mapped = labels[planId];
  if (mapped) return `Command Code · ${mapped}`;
  const title = planId
    .replace(/^individual-/, "")
    .replace(/^team-/, "Team ")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `Command Code · ${title || planId}`;
}

function creditRemaining(credits) {
  return (
    Math.max(0, toFiniteNumber(credits.monthlyCredits, 0)) +
    Math.max(0, toFiniteNumber(credits.purchasedCredits, 0)) +
    Math.max(0, toFiniteNumber(credits.freeCredits, 0))
  );
}

function windowQuota(window, displayName) {
  const w = window && typeof window === "object" ? window : {};
  const cap = toFiniteNumber(w.cap, 0);
  if (!(cap > 0)) return null;
  const used = toFiniteNumber(w.used, 0);
  const remaining = Math.max(0, cap - used);
  return withCurrency(
    {
      used,
      total: cap,
      remaining,
      remainingPercentage: cap > 0 ? Math.round((remaining / cap) * 1000) / 10 : 0,
      resetAt: parseResetTime(w.resetAt),
      unlimited: false,
    },
    displayName
  );
}

/** Pure window/credit assembly, exported for tests. */
export function buildCommandCodeQuotas(credits, windowLimits, summary, subscription, planId) {
  const quotas = {};
  const fiveHour = windowQuota(windowLimits?.fiveHour, "5-hour window");
  if (fiveHour) quotas.five_hour = fiveHour;
  const weekly = windowQuota(windowLimits?.weekly, "Weekly window");
  if (weekly) quotas.weekly = weekly;

  const periodUsed = toFiniteNumber(summary?.totalCost, Number.NaN);
  const used = Number.isFinite(periodUsed) && periodUsed >= 0 ? periodUsed : 0;
  const remaining = creditRemaining(credits || {});
  const total = used + remaining;
  quotas.credits = withCurrency(
    {
      used,
      total,
      remaining,
      remainingPercentage:
        total > 0 ? Math.round((remaining / total) * 1000) / 10 : remaining > 0 ? 100 : 0,
      resetAt: parseResetTime(subscription?.currentPeriodEnd),
      unlimited: false,
      grantedBalance: Math.max(0, toFiniteNumber(credits?.monthlyCredits, 0)),
      toppedUpBalance:
        Math.max(0, toFiniteNumber(credits?.purchasedCredits, 0)) +
        Math.max(0, toFiniteNumber(credits?.freeCredits, 0)),
    },
    "Credits"
  );
  return quotas;
}

export async function getCommandCodeUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Command Code API key not available. Add a key to view usage." };
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    // The API's edge WAF rejects generic library UAs (Cloudflare 1010).
    "User-Agent": "commandcode/0.25.7 (Macintosh; Intel Mac OS X 10_15_7) Node/22",
    "x-command-code-version": "0.25.7",
    "x-cli-environment": "cli",
  };

  const fetchJson = async (path, timeoutMs = 10000) => {
    const res = await fetchWithTimeout(
      `${COMMAND_CODE_API_BASE}${path}`, { method: "GET", headers }, timeoutMs, proxyOptions
    );
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  };

  const rejected = (reason) => ({
    message: `Command Code connected. ${reason}`,
  });

  try {
    let orgId = null;
    try {
      const whoami = await fetchJson("/alpha/whoami");
      if (whoami.status === 401 || whoami.status === 403) return rejected("The API key was rejected — reconnect or rotate the key.");
      if (whoami.ok && whoami.body && whoami.body.org) {
        const id = whoami.body.org.id;
        if (typeof id === "string" && id.trim()) orgId = id.trim();
      }
    } catch { /* optional */ }

    const q = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
    const creditsRes = await fetchJson(`/alpha/billing/credits${q}`);
    if (creditsRes.status === 401 || creditsRes.status === 403) return rejected("The API key was rejected — reconnect or rotate the key.");
    if (!creditsRes.ok || !creditsRes.body) {
      return rejected(`/alpha/billing/credits returned HTTP ${creditsRes.status}.`);
    }

    const credits = creditsRes.body.credits && typeof creditsRes.body.credits === "object" ? creditsRes.body.credits : {};
    const windowLimits = creditsRes.body.windowLimits && typeof creditsRes.body.windowLimits === "object" ? creditsRes.body.windowLimits : {};

    let subscription = null;
    try {
      const subRes = await fetchJson(`/alpha/billing/subscriptions${q}`);
      if (subRes.ok && subRes.body) subscription = subRes.body.data || subRes.body;
    } catch { /* soft-fail */ }

    let summary = null;
    try {
      const since = subscription?.currentPeriodStart
        ? `${q ? `${q}&` : "?"}since=${encodeURIComponent(subscription.currentPeriodStart)}`
        : q;
      const sumRes = await fetchJson(`/alpha/usage/summary${since}`);
      if (sumRes.ok && sumRes.body) summary = sumRes.body;
    } catch { /* soft-fail */ }

    const quotas = buildCommandCodeQuotas(credits, windowLimits, summary, subscription, subscription?.planId);

    return {
      plan: humanizePlanId(subscription?.planId),
      quotas,
      windowExceeded: typeof windowLimits.exceeded === "string" ? windowLimits.exceeded : null,
      limited: windowLimits.limited === true,
    };
  } catch (error) {
    return { message: `Command Code usage error: ${error?.message || String(error)}` };
  }
}