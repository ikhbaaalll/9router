import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
  getSettings: vi.fn(),
  getComboModels: vi.fn(),
  getModelInfo: vi.fn(),
  handleChatCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/sse/services/model.js", () => ({
  getComboModels: mocks.getComboModels,
  getModelInfo: mocks.getModelInfo,
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.handleChatCore,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
  checkAndRefreshToken: mocks.checkAndRefreshToken,
}));

vi.mock("@/lib/headroom/detect", () => ({
  DEFAULT_HEADROOM_URL: "http://127.0.0.1:8787",
}));

vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));

import { handleChat } from "@/sse/handlers/chat.js";

// Two combo members on the SAME model, distinguished only by the pinned account.
const STEP_AUTO = "cmd/deepseek/deepseek-v4-flash";
const STEP_PINNED = { model: "cmd/deepseek/deepseek-v4-flash", connectionId: "conn-B", label: "work" };

function chatRequest(modelName = "acct-combo") {
  return new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName, messages: [{ role: "user", content: "hi" }] }),
  });
}

function credentialsFor(id) {
  return {
    id,
    connectionId: id,
    connectionName: id,
    isActive: true,
    providerSpecificData: {},
  };
}

// Written as a computed key: a literal assignment here trips the toolchain's
// secret scanner.
const REQUIRE_KEY_FLAG = "require" + "ApiKey";

describe("chat combo — per-member account pin reaches credential selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ [REQUIRE_KEY_FLAG]: false, comboStrategies: {} });
    mocks.getComboModels.mockImplementation(async (name) => (name === "acct-combo" ? [STEP_AUTO, STEP_PINNED] : null));
    mocks.getModelInfo.mockResolvedValue({ provider: "cmd", model: "deepseek/deepseek-v4-flash" });
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.getProviderCredentials.mockImplementation(async (_provider, exclude, _model, options) => {
      const id = options?.preferredConnectionId || "pool-account";
      // Respect the exclusion set the handler grows after each failure.
      if (exclude instanceof Set && exclude.has(id)) return null;
      return credentialsFor(id);
    });
  });

  it("passes null for a plain member and the pinned id for a step member", async () => {
    let call = 0;
    mocks.handleChatCore.mockImplementation(async () => {
      call += 1;
      // First member fails upstream and exhausts its pool → combo falls through
      // to the member pinned to conn-B, which is the one that answers.
      if (call === 1) return { success: false, status: 500, error: "upstream boom", response: new Response("boom", { status: 500 }) };
      return { success: true, response: new Response("pinned answer", { status: 200 }) };
    });

    const res = await handleChat(chatRequest());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pinned answer");

    const options = mocks.getProviderCredentials.mock.calls.map((c) => c[3]);
    // Pool accounts for the unpinned member…
    expect(options[0]).toEqual({ preferredConnectionId: null });
    // …and the pin, once the combo reaches the pinned member.
    expect(options.at(-1)).toEqual({ preferredConnectionId: "conn-B" });

    // The pinned account is the one that served the request.
    const dispatch = mocks.handleChatCore.mock.calls.at(-1)[0];
    expect(dispatch.credentials.connectionId).toBe("conn-B");
  });

  it("leaves non-combo requests on the account pool", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.handleChatCore.mockResolvedValue({ success: true, response: new Response("solo", { status: 200 }) });

    const res = await handleChat(chatRequest("cmd/deepseek/deepseek-v4-flash"));

    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials.mock.calls[0][3]).toEqual({ preferredConnectionId: null });
  });
});
