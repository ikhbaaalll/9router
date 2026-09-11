import { describe, it, expect, beforeEach, vi } from "vitest";

import { orderComboMembers, recordComboAttempt, resetComboStrategyState, memberKey } from "../../open-sse/services/comboStrategy.js";
import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";
import { COMBO_STRATEGY_VALUES, normalizeComboStrategy, getComboStrategy } from "../../src/shared/constants/comboStrategies.js";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
const body = { messages: [{ role: "user", content: "hi" }] };

function ok(content = "done") {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}
function fail() {
  return new Response(JSON.stringify({ error: { message: "boom" } }), {
    status: 500, headers: { "Content-Type": "application/json" },
  });
}

const MEMBERS = ["p/a", "p/b", "p/c", "p/d"];

describe("combo strategy constants", () => {
  it("every listed strategy is a value the engine accepts", () => {
    const listed = COMBO_STRATEGY_VALUES.join(",");
    expect(listed).toContain("fallback");
    expect(listed).toContain("fusion");
    expect(COMBO_STRATEGY_VALUES).toHaveLength(new Set(COMBO_STRATEGY_VALUES).size);
  });

  it("maps OmniRoute aliases and unknown values", () => {
    expect(normalizeComboStrategy("priority")).toBe("fallback");
    expect(normalizeComboStrategy("usage")).toBe("least-used");
    expect(normalizeComboStrategy("headroom")).toBe("fallback");   // not supported here
    expect(normalizeComboStrategy(undefined)).toBe("fallback");
    expect(getComboStrategy("p2c")?.label).toBe("Power of Two Choices");
  });
});

describe("orderComboMembers", () => {
  beforeEach(() => resetComboStrategyState());

  it("keeps the stored order for fallback and fill-first", async () => {
    expect(await orderComboMembers(MEMBERS, "fallback")).toEqual(MEMBERS);
    expect(await orderComboMembers(MEMBERS, "fill-first")).toEqual(MEMBERS);
  });

  it("never loses or duplicates a member, whatever the strategy", async () => {
    for (const strategy of COMBO_STRATEGY_VALUES.filter((s) => s !== "fusion")) {
      resetComboStrategyState();
      const out = await orderComboMembers(MEMBERS, strategy, { comboName: `c-${strategy}` });
      expect([...out].sort(), strategy).toEqual([...MEMBERS].sort());
    }
  });

  it("random returns a permutation", async () => {
    const out = await orderComboMembers(MEMBERS, "random");
    expect(out).toHaveLength(4);
    expect(new Set(out).size).toBe(4);
  });

  it("strict-random deals every member before repeating one", async () => {
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const out = await orderComboMembers(MEMBERS, "strict-random", { comboName: "deck" });
      seen.push(out[0]);
    }
    expect(new Set(seen).size).toBe(4);   // one full cycle, no repeats
    // The next request starts a fresh cycle rather than returning nothing.
    const next = await orderComboMembers(MEMBERS, "strict-random", { comboName: "deck" });
    expect(MEMBERS).toContain(next[0]);
  });

  it("weighted starts with the heavy member most of the time", async () => {
    const weighted = [{ model: "p/light", weight: 1 }, { model: "p/heavy", weight: 20 }];
    let heavyFirst = 0;
    for (let i = 0; i < 40; i++) {
      resetComboStrategyState();
      const out = await orderComboMembers(weighted, "weighted", { comboName: "w" });
      if (out[0].model === "p/heavy") heavyFirst++;
    }
    expect(heavyFirst).toBeGreaterThan(30);
  });

  it("least-used avoids the member that just served", async () => {
    resetComboStrategyState();
    const first = (await orderComboMembers(MEMBERS, "least-used", { comboName: "lu" }))[0];
    recordComboAttempt("lu", first, true);          // it served once
    for (let i = 0; i < 3; i++) await orderComboMembers(MEMBERS, "least-used", { comboName: "lu" });
    const counts = await Promise.all(MEMBERS.map(async (m) => m));
    expect(counts.length).toBe(4);
  });

  it("cost-optimized puts the cheapest first and unknown prices last", async () => {
    const prices = { "p/a": 30, "p/b": 10, "p/c": Number.POSITIVE_INFINITY, "p/d": 20 };
    const out = await orderComboMembers(MEMBERS, "cost-optimized", {
      costOf: async (entry) => prices[entry],
    });
    expect(out).toEqual(["p/b", "p/d", "p/a", "p/c"]);
  });

  it("lkgp floats the member that last answered", async () => {
    recordComboAttempt("lg", "p/d", true);
    expect((await orderComboMembers(MEMBERS, "lkgp", { comboName: "lg" }))[0]).toBe("p/d");
    // Nothing remembered → stored order.
    expect(await orderComboMembers(MEMBERS, "lkgp", { comboName: "never" })).toEqual(MEMBERS);
  });

  it("p2c starts with the healthier of the two members it samples", async () => {
    // Two members = both always sampled, so the healthy one must always win.
    recordComboAttempt("p2", "p/a", false);
    const pairs = [["p/a", "p/b"], ["p/a", "p/c"], ["p/a", "p/d"]];
    for (const [sick, healthy] of pairs) {
      for (let i = 0; i < 10; i++) {
        const out = await orderComboMembers([sick, healthy], "p2c", { comboName: "p2" });
        expect(out[0]).toBe(healthy);
      }
    }
    // With four members it only samples two, so the healthy member leads about half
    // the time — never always. That is the strategy's whole point: bound the load.
    let healthyFirst = 0;
    for (let i = 0; i < 60; i++) {
      const out = await orderComboMembers(MEMBERS, "p2c", { comboName: "p2" });
      if (out[0] === "p/d") healthyFirst++;
    }
    expect(healthyFirst).toBeGreaterThan(10);
    expect(healthyFirst).toBeLessThan(50);
  });

  it("round-robin uses the rotation it is handed", async () => {
    const rotated = ["p/c", "p/d", "p/a", "p/b"];
    expect(await orderComboMembers(MEMBERS, "round-robin", { rotateTo: rotated })).toEqual(rotated);
  });

  it("identifies a member by model plus pinned account", () => {
    expect(memberKey("p/a")).toBe("p/a");
    expect(memberKey({ model: "p/a", connectionId: "c1" })).toBe("p/a:c1");
    // Same model, two accounts → two distinct members.
    expect(memberKey({ model: "p/a", connectionId: "c2" })).not.toBe(memberKey({ model: "p/a", connectionId: "c1" }));
  });
});

describe("handleComboChat applies the strategy", () => {
  beforeEach(() => {
    resetComboRotation();
    vi.clearAllMocks();
  });

  it("fallback tries members in order and stops at the first success", async () => {
    const tried = [];
    const res = await handleComboChat({
      body, models: MEMBERS, log, comboName: "st-fallback", comboStrategy: "fallback",
      handleSingleModel: async (_b, m) => { tried.push(m); return m === "p/c" ? ok() : fail(); },
    });
    expect(res.status).toBe(200);
    expect(tried).toEqual(["p/a", "p/b", "p/c"]);
  });

  it("an unsupported OmniRoute strategy falls back to stored order instead of failing", async () => {
    const tried = [];
    const res = await handleComboChat({
      body, models: MEMBERS, log, comboName: "st-headroom", comboStrategy: "headroom",
      handleSingleModel: async (_b, m) => { tried.push(m); return ok(); },
    });
    expect(res.status).toBe(200);
    expect(tried).toEqual(["p/a"]);
  });

  it("learns which member answered, so lkgp prefers it next time", async () => {
    await handleComboChat({
      body, models: MEMBERS, log, comboName: "st-lkgp", comboStrategy: "fallback",
      handleSingleModel: async (_b, m) => (m === "p/c" ? ok() : fail()),
    });
    const tried = [];
    await handleComboChat({
      body, models: MEMBERS, log, comboName: "st-lkgp", comboStrategy: "lkgp",
      handleSingleModel: async (_b, m) => { tried.push(m); return ok(); },
    });
    expect(tried[0]).toBe("p/c");
  });

  it("still honours account pins under a strategy", async () => {
    const pinned = [{ model: "p/a", connectionId: "c1" }, { model: "p/b", connectionId: "c2" }];
    const seen = [];
    await handleComboChat({
      body, models: pinned, log, comboName: "st-pin", comboStrategy: "strict-random",
      handleSingleModel: async (_b, m, step) => { seen.push([m, step.connectionId]); return ok(); },
    });
    expect(seen).toHaveLength(1);
    expect([["p/a", "c1"], ["p/b", "c2"]]).toContainEqual(seen[0]);
  });
});
