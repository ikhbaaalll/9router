/**
 * ClinePass (app.cline.bot / api.cline.bot) usage.
 *
 * ClinePass is a flat-rate subscription; its quota is the per-window USD
 * inference cap from the plan entitlements vs. the spend tallied from the
 * usage ledger:
 *   GET /api/v1/users/me            → data.id (the Cline user id)
 *   GET /api/v1/users/{id}/plan     → plan.entitlements.cline_pass.inferenceCapThreshold
 *                                      { last5Hours…, last7days…, last30days… } (micro-USD)
 *   GET /api/v1/users/{id}/usages   → newest-first ledger, items.costUsd (micro-USD)
 *
 * Verified live 2026-09-12: OAuth access tokens keep the `workos:` prefix;
 * API keys use a bare Bearer token. The Cline and ClinePass auth helpers share
 * this format.
 */

import { fetchWithTimeout } from "./shared.js";
import { buildClineHeaders } from "../../shared/clineAuth.js";

const CLINE_API_BASE = "https://api.cline.bot";
const MICRO = 1_000_000;
const USAGES_PAGE_SIZE = 200;
const MAX_USAGES_PAGES = 32;

const WINDOWS = [
  { key: "5h", capField: "last5HoursUsageCostUSDPerUser", label: "5-hour window" },
  { key: "7d", capField: "last7daysUsageCostUSDPerUser", label: "7-day window" },
  { key: "30d", capField: "last30daysUsageCostUSDPerUser", label: "30-day window" },
];
const WINDOW_MS = { "5h": 5 * 3600_000, "7d": 7 * 24 * 3600_000, "30d": 30 * 24 * 3600_000 };

function buildHeaders(accessToken) {
  return buildClineHeaders(accessToken, {
    Accept: "application/json",
    "Content-Type": "application/json",
  });
}

/**
 * Pure ledger → window quotas, exported for tests.
 * costUsd arrives in micro-USD (e.g. 7127 ⇒ $0.007); caps live in the same unit,
 * so sums and ratios are exact and both sides render as dollars below.
 */
export function buildClinepassQuotas(items, caps) {
  const now = Date.now();
  const quotas = {};
  for (const { key, capField, label } of WINDOWS) {
    const capMicro = Number(caps?.[capField]);
    if (!Number.isFinite(capMicro) || capMicro <= 0) continue;
    const cutoff = now - WINDOW_MS[key];
    let usedMicro = 0;
    for (const item of items || []) {
      const ts = Date.parse(item.createdAt);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const cost = Number(item.costUsd);
      if (Number.isFinite(cost) && cost > 0) usedMicro += cost;
    }
    const used = usedMicro / MICRO;
    const total = capMicro / MICRO;
    const remaining = Math.max(0, total - used);
    quotas[key] = {
      used,
      total,
      remaining,
      remainingPercentage: total > 0 ? Math.round((remaining / total) * 1000) / 10 : 0,
      resetAt: null, // sliding windows never reset
      unlimited: false,
      currency: "USD",
      displayName: label,
    };
  }
  return quotas;
}

export async function getClinepassUsage(accessToken, providerSpecificData = null, proxyOptions = null) {
  if (!accessToken) {
    return { message: "ClinePass token not available. Reconnect the account to view usage." };
  }

  const fetchJson = async (path, timeoutMs = 10000) => {
    const res = await fetchWithTimeout(
      `${CLINE_API_BASE}${path}`, { method: "GET", headers: buildHeaders(accessToken) }, timeoutMs, proxyOptions
    );
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  };

  try {
    const me = await fetchJson("/api/v1/users/me");
    if (me.status === 401 || me.status === 403) {
      return { message: "ClinePass connected. The token was rejected — reconnect or rotate the account." };
    }
    if (!me.ok || !me.body || !me.body.data || typeof me.body.data.id !== "string") {
      return { message: `ClinePass connected. /users/me returned HTTP ${me.status}.` };
    }
    const uid = me.body.data.id;

    const [planRes, ledgerRes] = await Promise.all([
      fetchJson("/api/v1/users/me/plan"),
      fetchJson(`/api/v1/users/${encodeURIComponent(uid)}/usages?limit=${USAGES_PAGE_SIZE}`),
    ]);

    const plan = planRes.ok && planRes.body?.data?.plan ? planRes.body.data.plan : null;
    const entitlements = plan?.entitlements?.cline_pass;
    const caps = entitlements?.inferenceCapThreshold;
    if (!caps) {
      return {
        plan: plan?.displayName || "ClinePass",
        message: "ClinePass connected. No inference caps on this plan.",
      };
    }

    // Ledger pages are newest-first; stop as soon as a page passes the 30-day
    // window (older entries cannot contribute to any window).
    // ponytail: heavy accounts could outgrow MAX_USAGES_PAGES; raise it or switch
    // to date-filtered paging if a page boundary ever splits a window.
    let items = [];
    let next = ledgerRes.body?.data?.nextToken || ledgerRes.body?.data?.nextCursor || null;
    if (ledgerRes.ok && Array.isArray(ledgerRes.body?.data?.items)) {
      items = ledgerRes.body.data.items;
    }
    let pages = 1;
    while (next && pages < MAX_USAGES_PAGES) {
      // Cline's current API uses `cursor`; older builds exposed nextToken but
      // accepted the same cursor value. Keep the fallback for both response shapes.
      const page = await fetchJson(
        `/api/v1/users/${encodeURIComponent(uid)}/usages?limit=${USAGES_PAGE_SIZE}&cursor=${encodeURIComponent(next)}`
      );
      const data = page.ok ? page.body?.data : null;
      if (!data || !Array.isArray(data.items)) break;
      items = items.concat(data.items);
      const previous = next;
      next = data.nextToken || data.nextCursor || null;
      pages += 1;
      const oldest = Date.parse(items[items.length - 1]?.createdAt);
      if (!next || next === previous || (Number.isFinite(oldest) && oldest < Date.now() - WINDOW_MS["30d"])) break;
    }

    return {
      plan: plan?.displayName || "ClinePass",
      quotas: buildClinepassQuotas(items, caps),
      period: planRes.body?.data?.currentPeriodEnd || null,
    };
  } catch (error) {
    return { message: `ClinePass usage error: ${error?.message || String(error)}` };
  }
}