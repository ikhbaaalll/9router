import { describe, it, expect, beforeEach, vi } from "vitest";

import { handleComboChat, handleFusionChat, reorderByCapabilities, resetComboRotation } from "../../open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter } from "../../open-sse/services/capacityAdapter.js";
import {
  comboStepTarget,
  comboStepConnectionId,
  comboStepDisplay,
  normalizeComboSteps,
} from "../../src/shared/utils/comboSteps.js";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
const body = { messages: [{ role: "user", content: "hi" }] };

function ok(content = "done") {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fail(status = 500) {
  return new Response(JSON.stringify({ error: { message: "upstream boom" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("combo step helpers — account pinning", () => {
  it("keeps legacy strings untouched", () => {
    expect(comboStepTarget("cmd/deepseek/deepseek-v4-flash")).toBe("cmd/deepseek/deepseek-v4-flash");
    expect(comboStepConnectionId("cmd/deepseek/deepseek-v4-flash")).toBe(null);
  });

  it("reads a pinned account off a step object", () => {
    const step = { model: "cmd/deepseek/deepseek-v4-flash", connectionId: "conn-2" };
    expect(comboStepTarget(step)).toBe("cmd/deepseek/deepseek-v4-flash");
    expect(comboStepConnectionId(step)).toBe("conn-2");
    expect(comboStepDisplay(step)).toBe("cmd/deepseek/deepseek-v4-flash @conn-2");
  });

  it("joins a separate provider only when the model has no slash of its own", () => {
    // OmniRoute shape: provider + bare model
    expect(comboStepTarget({ provider: "cmd", model: "gpt-5.6" })).toBe("cmd/gpt-5.6");
    // 9router model ids may contain slashes — never re-join those
    expect(comboStepTarget({ provider: "cmd", model: "deepseek/deepseek-v4-flash" })).toBe("deepseek/deepseek-v4-flash");
  });

  it("treats an empty or junk pin as auto", () => {
    expect(comboStepConnectionId({ model: "a/b", connectionId: "  " })).toBe(null);
    expect(comboStepConnectionId({ model: "a/b" })).toBe(null);
    expect(comboStepTarget({})).toBe("");
    expect(comboStepTarget(null)).toBe("");
  });

  it("normalizes stored members and rejects unusable ones", () => {
    expect(normalizeComboSteps(["a/b", { model: "a/c", connectionId: "conn-1" }])).toEqual({
      models: ["a/b", { model: "a/c", connectionId: "conn-1" }],
      error: null,
    });
    // No pin → plain string, so older readers keep working
    expect(normalizeComboSteps([{ model: "a/b", connectionId: "" }]).models).toEqual(["a/b"]);
    // Label survives when a pin is set
    expect(normalizeComboSteps([{ model: "a/b", connectionId: "c1", label: "work" }]).models)
      .toEqual([{ model: "a/b", connectionId: "c1", label: "work" }]);
    expect(normalizeComboSteps([{ nope: true }]).error).toBeTruthy();
  });
});

describe("handleComboChat forwards the step (account pin) to the caller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetComboRotation();
  });

  it("passes the pinned step of the winning member", async () => {
    const seen = [];
    const steps = ["auto/model", { model: "pinned/model", connectionId: "conn-2" }];
    const res = await handleComboChat({
      body,
      models: steps,
      handleSingleModel: async (_b, modelStr, step) => { seen.push([modelStr, step]); return ok(); },
      log,
      comboName: "acct-combo",
      comboStrategy: "fallback",
    });

    expect(res.ok).toBe(true);
    // First member failed? No — first member is tried and succeeds here.
    expect(seen).toEqual([["auto/model", "auto/model"]]);
  });

  it("falls through to the next member and hands over that member's pin", async () => {
    const seen = [];
    const res = await handleComboChat({
      body,
      models: [
        { model: "pinned/model-a", connectionId: "conn-1" },
        { model: "pinned/model-b", connectionId: "conn-2" },
      ],
      handleSingleModel: async (_b, modelStr, step) => {
        seen.push([modelStr, comboStepConnectionId(step)]);
        return seen.length === 1 ? fail() : ok("second");
      },
      log,
      comboName: "acct-fallback",
      comboStrategy: "fallback",
    });

    expect(res.status).toBe(200);
    expect(seen).toEqual([
      ["pinned/model-a", "conn-1"],
      ["pinned/model-b", "conn-2"],
    ]);
  });

  it("keeps legacy string combos working", async () => {
    const seen = [];
    await handleComboChat({
      body,
      models: ["provider/model-a", "provider/model-b"],
      handleSingleModel: async (_b, modelStr, step) => { seen.push([modelStr, step]); return ok(); },
      log,
      comboName: "legacy",
      comboStrategy: "fallback",
    });

    expect(seen).toEqual([["provider/model-a", "provider/model-a"]]);
  });
});

describe("combo helpers tolerate step objects", () => {
  it("reorders by capability without touching the entries", () => {
    const steps = [{ model: "vision/model-a", connectionId: "c1" }, { model: "plain/model-b" }];
    const out = reorderByCapabilities(steps, new Set(["vision"]));
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ model: "vision/model-a", connectionId: "c1" });
  });

  it("counts adapter capacity from a step object instead of crashing", () => {
    const settings = { capacityAdapter: { vision: { enabled: true, models: ["pool/vision-model"] } } };
    const out = augmentModelsWithCapacityAdapter([{ model: "plain/model-b" }], new Set(["vision"]), settings);
    expect(out).toContain("pool/vision-model");
    expect(out).toContainEqual({ model: "plain/model-b" });
  });
});

describe("handleFusionChat forwards panel pins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetComboRotation();
  });

  it("pins every panel call and reuses panel[0]'s pin for the judge", async () => {
    const seen = [];
    const res = await handleFusionChat({
      body,
      models: [
        { model: "pinned/model-a", connectionId: "conn-1" },
        { model: "pinned/model-b", connectionId: "conn-2" },
      ],
      handleSingleModel: async (_b, modelStr, step) => {
        seen.push([modelStr, comboStepConnectionId(step)]);
        return ok(`answer from ${modelStr}`);
      },
      log,
      comboName: "fusion-pinned",
    });

    expect(res.status).toBe(200);
    // 2 panel calls, then 1 judge call reusing panel[0]'s pin
    expect(seen).toEqual([
      ["pinned/model-a", "conn-1"],
      ["pinned/model-b", "conn-2"],
      ["pinned/model-a", "conn-1"],
    ]);
  });
});
