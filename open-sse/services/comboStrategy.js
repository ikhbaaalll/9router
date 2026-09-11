/**
 * Combo strategy ordering — decides which member a request starts with.
 *
 * Ported from OmniRoute's `applyStrategyOrdering` /
 * `orderTargetsByPowerOfTwoChoices` / `sortTargetsByUsage` / `sortTargetsByCost`,
 * reduced to what this router can support without extra infrastructure. Every
 * function here only REORDERS the member list; the fallback loop in combo.js still
 * walks the whole list when the first member fails, so a bad ordering can never
 * make a combo fail that would otherwise have answered.
 *
 * Dependency-free (no DB, no app imports) so it stays testable in isolation.
 */
import { comboStepTarget, comboStepConnectionId, comboStepWeight } from "@/shared/utils/comboSteps.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";

// ── in-memory state ─────────────────────────────────────────────────────────
// Keyed per combo. Cleared on process restart, which is fine: these are hints that
// re-learn within a few requests.
//   ponytail: process-local state, not shared across replicas. Move to the DB if the
//   router ever runs multi-instance.
const usageCounts = new Map();   // comboName -> Map<memberKey, requests>
const failureScores = new Map(); // comboName -> Map<memberKey, recentFailureWeight>
const decks = new Map();         // comboName -> Set<memberKey> already dealt this cycle
const lastGood = new Map();      // comboName -> memberKey

/** Identity of a member for state, strategy and logging: model + pinned account. */
export function memberKey(entry) {
  const target = comboStepTarget(entry);
  const connectionId = comboStepConnectionId(entry);
  return connectionId ? `${target}:${connectionId}` : target;
}

// ── small helpers ───────────────────────────────────────────────────────────
function bump(map, key, delta) {
  map.set(key, (map.get(key) || 0) + delta);
}

function scoreFailure(comboName, key, failed) {
  const map = getMap(failureScores, comboName);
  if (failed) bump(map, key, 1);
  // Decay so a member that recovered stops being punished.
  else if (map.has(key)) map.set(key, Math.max(0, map.get(key) - 1));
}

function getMap(store, comboName) {
  let map = store.get(comboName);
  if (!map) { map = new Map(); store.set(comboName, map); }
  return map;
}

/** Sorted copy, keeping the original relative order for ties. */
function stableSort(entries, scoreOf) {
  return entries
    .map((entry, index) => ({ entry, index, score: scoreOf(entry) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((x) => x.entry);
}

// ── the strategies ──────────────────────────────────────────────────────────

/** Weighted pick, then the rest in descending weight order (OmniRoute's behavior). */
function weightedOrder(entries, comboName) {
  const picked = new Map();
  for (const entry of entries) picked.set(memberKey(entry), entry);

  const queue = [...entries];
  const out = [];
  while (queue.length > 0) {
    const total = queue.reduce((sum, e) => sum + comboStepWeight(e), 0);
    let roll = Math.random() * total;
    let chosen = queue.length - 1;
    for (let i = 0; i < queue.length; i++) {
      roll -= comboStepWeight(queue[i]);
      if (roll <= 0) { chosen = i; break; }
    }
    out.push(queue.splice(chosen, 1)[0]);
  }
  // Record the pick so usage-based strategies see it.
  if (out[0]) bump(getMap(usageCounts, comboName), memberKey(out[0]), 1);
  return out;
}

function shuffleOrder(entries) {
  const out = [...entries];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Deal each member once before repeating any. */
function strictRandomOrder(entries, comboName) {
  const keys = entries.map(memberKey);
  let dealt = decks.get(comboName);
  if (!dealt) { dealt = new Set(); decks.set(comboName, dealt); }

  const remaining = keys.filter((k) => !dealt.has(k));
  if (remaining.length === 0) {
    // Deck exhausted (members changed, or all dealt) — start a new cycle.
    dealt.clear();
    remaining.push(...keys);
  }
  const pick = remaining[Math.floor(Math.random() * remaining.length)];
  dealt.add(pick);

  const rest = shuffleOrder(entries.filter((e) => memberKey(e) !== pick));
  const head = entries.find((e) => memberKey(e) === pick);
  return [head, ...rest].filter(Boolean);
}

/** Two random members; start with the one that failed less recently. */
function p2cOrder(entries, comboName) {
  if (entries.length <= 1) return entries;
  const i = Math.floor(Math.random() * entries.length);
  let j = Math.floor(Math.random() * (entries.length - 1));
  if (j >= i) j++;
  const failures = getMap(failureScores, comboName);
  const worse = (failures.get(memberKey(entries[i])) || 0) > (failures.get(memberKey(entries[j])) || 0);
  const chosen = worse ? j : i;
  return [entries[chosen], ...entries.filter((_, index) => index !== chosen)];
}

/** Fewest requests so far first. */
function leastUsedOrder(entries, comboName) {
  const counts = getMap(usageCounts, comboName);
  const ordered = stableSort(entries, (e) => counts.get(memberKey(e)) || 0);
  if (ordered[0]) bump(counts, memberKey(ordered[0]), 1);
  return ordered;
}

function contextSizeOf(entry) {
  const target = comboStepTarget(entry);
  const slash = target.indexOf("/");
  const provider = slash > 0 ? target.slice(0, slash) : "";
  const model = slash > 0 ? target.slice(slash + 1) : target;
  const caps = getCapabilitiesForModel(provider, model);
  return Number(caps?.contextWindow) || 0;
}

/** Largest context window first. */
function contextOptimizedOrder(entries) {
  return stableSort(entries, (e) => -contextSizeOf(e));
}

// ── public entry point ──────────────────────────────────────────────────────

/**
 * Order combo members for one request.
 *
 * @param {Array<string|Object>} entries - Combo members
 * @param {string} strategy - A value from COMBO_STRATEGY_VALUES
 * @param {Object} [ctx]
 * @param {string} [ctx.comboName] - Key for the per-combo state
 * @param {Function} [ctx.costOf] - async (member) => number, input price per 1M; used by cost-optimized
 * @param {number|string} [ctx.stickyLimit] - Requests per member before rotating (round-robin)
 * @param {string[]} [ctx.rotateTo] - Precomputed rotation for round-robin (from combo.js)
 * @returns {Promise<Array<string|Object>>} Ordered members used as the attempt order
 */
export async function orderComboMembers(entries, strategy, ctx = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (list.length <= 1) return list;

  const comboName = ctx.comboName || "__default__";

  switch (strategy) {
    case "fill-first":
      // Same order as fallback: exhaust the first member before trying the next.
      return list;

    case "round-robin":
      // Rotation is computed by combo.js (it owns the sticky counter); pass it in.
      return Array.isArray(ctx.rotateTo) && ctx.rotateTo.length === list.length
        ? ctx.rotateTo
        : list;

    case "weighted":
      return weightedOrder(list, comboName);

    case "random":
      return shuffleOrder(list);

    case "strict-random":
      return strictRandomOrder(list, comboName);

    case "p2c":
      return p2cOrder(list, comboName);

    case "least-used":
      return leastUsedOrder(list, comboName);

    case "context-optimized":
      return contextOptimizedOrder(list);

    case "cost-optimized": {
      if (typeof ctx.costOf !== "function") return list;
      try {
        const priced = await Promise.all(
          list.map(async (entry) => ({
            entry,
            cost: await ctx.costOf(entry).catch(() => Number.POSITIVE_INFINITY),
          }))
        );
        // Unknown prices sort last rather than first.
        return priced
          .map((x, index) => ({ ...x, index, cost: Number.isFinite(x.cost) ? x.cost : Number.POSITIVE_INFINITY }))
          .sort((a, b) => a.cost - b.cost || a.index - b.index)
          .map((x) => x.entry);
      } catch {
        return list;
      }
    }

    case "lkgp": {
      const good = lastGood.get(comboName);
      if (!good) return list;
      const at = list.findIndex((e) => memberKey(e) === good);
      if (at <= 0) return list;
      return [list[at], ...list.filter((_, i) => i !== at)];
    }

    // "fallback" and anything unrecognized keep the stored order.
    default:
      return list;
  }
}

/**
 * Record how an attempt went, so the hint-based strategies (p2c, least-used, lkgp)
 * can learn. Called by combo.js as each member is tried.
 *
 * @param {string} comboName
 * @param {string|Object} entry - The member that was tried
 * @param {boolean} ok - Whether it produced a usable response
 */
export function recordComboAttempt(comboName, entry, ok) {
  const key = memberKey(entry);
  if (ok) {
    lastGood.set(comboName, key);
    scoreFailure(comboName, key, false);
  } else {
    scoreFailure(comboName, key, true);
  }
}

/** Clear per-combo strategy state (used when a combo is edited). */
export function resetComboStrategyState(comboName) {
  if (comboName) {
    usageCounts.delete(comboName);
    failureScores.delete(comboName);
    decks.delete(comboName);
    lastGood.delete(comboName);
  } else {
    usageCounts.clear();
    failureScores.clear();
    decks.clear();
    lastGood.clear();
  }
}
