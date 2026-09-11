/**
 * Combo strategies this router implements.
 *
 * Ported from OmniRoute's `ROUTING_STRATEGY_VALUES`
 * (src/shared/constants/routingStrategies.ts), reduced to the strategies that need
 * no extra infrastructure here. OmniRoute-only strategies and what they would need
 * are listed at the bottom of this file.
 *
 * Dependency-free: imported by the open-sse engine (server) and the dashboard.
 */

/** @typedef {{ value: string, label: string, desc: string, when: string, icon: string }} ComboStrategy */

/** Valid strategy ids. Keep in sync with `orderComboMembers` in open-sse/services/combo.js. */
export const COMBO_STRATEGY_VALUES = [
  "fallback",
  "fill-first",
  "round-robin",
  "weighted",
  "random",
  "strict-random",
  "p2c",
  "least-used",
  "cost-optimized",
  "context-optimized",
  "lkgp",
  "fusion",
];

export const DEFAULT_COMBO_STRATEGY = "fallback";

/** @type {ComboStrategy[]} */
export const COMBO_STRATEGIES = [
  {
    value: "fallback",
    label: "Fallback",
    desc: "Try the members in order. First one that answers wins.",
    when: "Default. You listed the models best-first and want a backup for outages.",
    icon: "sort",
  },
  {
    value: "fill-first",
    label: "Fill First",
    desc: "Stay on the first member until it fails, then move on. Never rotates.",
    when: "One cheap or unmetered member should take every request it can carry.",
    icon: "vertical_align_top",
  },
  {
    value: "round-robin",
    label: "Round Robin",
    desc: "Rotate the starting member per request, sticky for N requests.",
    when: "Spread load across several equivalent members, all equally good.",
    icon: "autorenew",
  },
  {
    value: "weighted",
    label: "Weighted",
    desc: "Pick a member at random, odds set by each member's weight.",
    when: "You want roughly 70/30 across two members rather than strict rotation.",
    icon: "percent",
  },
  {
    value: "random",
    label: "Random",
    desc: "Shuffle the order every request. No memory between requests.",
    when: "Break up a hot first member without caring about exact shares.",
    icon: "shuffle",
  },
  {
    value: "strict-random",
    label: "Strict Random",
    desc: "Deal every member once before repeating any (a deck).",
    when: "Even use is required. Random without the streaks of plain random.",
    icon: "casino",
  },
  {
    value: "p2c",
    label: "Power of Two Choices",
    desc: "Sample two members at random, start with the healthier one.",
    when: "Many members and uneven health. Avoids piling onto one weak member.",
    icon: "balance",
  },
  {
    value: "least-used",
    label: "Least Used",
    desc: "Start with the member that has served the fewest requests.",
    when: "Balancing long-term spend across accounts or models.",
    icon: "low_priority",
  },
  {
    value: "cost-optimized",
    label: "Cost Optimized",
    desc: "Cheapest member by input price first, dearest as the last resort.",
    when: "Cost matters and quality is good enough across the members.",
    icon: "savings",
  },
  {
    value: "context-optimized",
    label: "Context Optimized",
    desc: "Largest context window first, smallest last.",
    when: "Long prompts. Start with the member that can hold all of it.",
    icon: "text_snippet",
  },
  {
    value: "lkgp",
    label: "Last Known Good",
    desc: "Remember which member answered last time and start there again.",
    when: "One member is reliably good. Keeps prompt caches warm.",
    icon: "verified",
  },
  {
    value: "fusion",
    label: "Fusion",
    desc: "Ask every panel member in parallel, then a judge writes one answer.",
    when: "Quality over cost on hard questions. N+1 calls per request.",
    icon: "hub",
  },
];

const BY_VALUE = new Map(COMBO_STRATEGIES.map((s) => [s.value, s]));

/** Normalize any stored value to a strategy this router knows. */
export function normalizeComboStrategy(value) {
  if (typeof value !== "string") return DEFAULT_COMBO_STRATEGY;
  const v = value.trim().toLowerCase();
  // Aliases carried over from OmniRoute's normalizeRoutingStrategy().
  if (v === "priority") return "fallback";
  if (v === "usage") return "least-used";
  return BY_VALUE.has(v) ? v : DEFAULT_COMBO_STRATEGY;
}

export function getComboStrategy(value) {
  return BY_VALUE.get(normalizeComboStrategy(value));
}

/**
 * Strategies OmniRoute offers that this router does NOT implement yet, and the
 * infrastructure each one needs. Selecting one of these in OmniRoute and moving the
 * combo here falls back to "fallback".
 *
 * - reset-aware / reset-window / headroom — needs live per-account quota windows
 *   (OmniRoute's quotaCache + provider quota probes).
 * - cache-optimized — needs prompt-cache affinity tracking per session.
 * - context-relay — needs cross-turn handoff summaries.
 * - auto — needs the intent classifier, mode packs and the candidate scoring engine.
 * - pipeline — sequential chain where step N feeds step N+1. Needs per-step `prompt`
 *   plumbing through the request path.
 * - quota-share — internal, minted by OmniRoute for quota-share keys.
 */
export const UNSUPPORTED_COMBO_STRATEGIES = [
  "reset-aware",
  "reset-window",
  "headroom",
  "cache-optimized",
  "context-relay",
  "auto",
  "pipeline",
  "quota-share",
];
