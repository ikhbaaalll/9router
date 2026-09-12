/**
 * One-shot migration: OmniRoute storage.sqlite -> 9router fork (DATA_DIR).
 *
 * Runs the FORK's own repo functions, so encryption, JSON shapes, usage
 * aggregation, and the lifetime counter all come out exactly as the app writes
 * them. Credentials are read decrypted from OmniRoute and stored the way the
 * fork stores them (plaintext inside the connection `data` JSON).
 *
 * Usage (container stopped):
 *   DATA_DIR=/home/wdftr/.9router-fork OMNI_SRC=/path/omni.sqlite \
 *   OMNI_ENC_KEY=$(cat ~/.hermes/scripts/omni_enc_key) \
 *   node scripts/migrate-omniroute.mjs
 *
 * Idempotent per record: existing ids/names are skipped, not duplicated.
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import {
  initDb,
  createProviderNode,
  getProviderNodes,
  createProviderConnection,
  getProviderConnections,
  createCombo,
  getCombos,
  saveRequestUsage,
  setModelAlias,
  getModelAliases,
  addCustomModel,
  updateSettings,
  getSettings,
} from "../src/lib/db/index.js";
import { AI_PROVIDERS, getProviderAlias } from "../src/shared/constants/providers.js";
import { normalizeComboModelId } from "./lib/normalizeComboModelId.mjs";

// Providers the fork's own registry already knows — no node needed for these.
const KNOWN_PROVIDERS = new Set(Object.keys(AI_PROVIDERS));

const SRC = process.env.OMNI_SRC;
const ENC_KEY = process.env.OMNI_ENC_KEY || "";
const ENC_SALT = process.env.OMNI_ENC_SALT || "omniroute-field-encryption-v1";
const USAGE_CHUNK = 5000;

if (!SRC) throw new Error("OMNI_SRC is required");

// ── OmniRoute credential decryption (enc:v1:iv:cipher:tag, AES-256-GCM) ───────
const keyCache = new Map();
function deriveKey() {
  if (!keyCache.has("k")) {
    keyCache.set("k", crypto.scryptSync(ENC_KEY, ENC_SALT, 32, { N: 2 ** 14, r: 8, p: 1 }));
  }
  return keyCache.get("k");
}

function decryptValue(v) {
  if (typeof v !== "string" || !v.startsWith("enc:v1:")) return v;
  if (!ENC_KEY) throw new Error("encrypted credential found but OMNI_ENC_KEY is empty");
  const [ivHex, cipherHex, tagHex] = v.slice("enc:v1:".length).split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", deriveKey(), Buffer.from(ivHex, "hex"));
  d.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([d.update(Buffer.from(cipherHex, "hex")), d.final()]).toString("utf8");
}

function parseMaybeJson(v) {
  if (typeof v !== "string") return v ?? null;
  try { return JSON.parse(v); } catch { return v; }
}

// ── provider id mapping: OmniRoute name -> fork name ────────────────────────
const PROVIDER_MAP = { "command-code": "commandcode" };
const mapProvider = (p) => PROVIDER_MAP[p] || p;

// Providers OmniRoute knows that this fork's registry does not: land them as
// custom OpenAI-compatible nodes. agentrouter.org is the one the old 9router
// install used (prefix `ar`).
const CUSTOM_FALLBACK_NODES = {
  agentrouter: {
    id: "openai-compatible-chat-agentrouter",
    name: "AgentRouter",
    prefix: "ar",
    baseUrl: "https://agentrouter.org/v1",
    models: [
      { id: "gpt-5.6-sol", name: "gpt-5.6-sol" },
      { id: "claude-opus-4-8", name: "claude-opus-4-8" },
      { id: "claude-opus-5", name: "claude-opus-5" },
    ],
  },
};

const report = { nodes: 0, connections: 0, combos: 0, aliases: 0, customModels: 0, usage: 0, skipped: [] };

// Connection ids are minted by the fork's repo, so OmniRoute ids are mapped to the
// ids the fork assigns. Combo pins and usage rows are rewritten through this map.
const connectionIdMap = new Map();

// `RESET_DERIVED=1` wipes everything this script creates (connections + combos it
// owns) so a re-run is clean. Combos the user made by hand are kept.
if (process.env.RESET_DERIVED === "1") {
  const KEEP = new Set((process.env.KEEP_COMBOS || "tesr").split(",").map((s) => s.trim()).filter(Boolean));
  const forkDb = new Database(process.env.DATA_DIR + "/db/data.sqlite");
  forkDb.prepare("DELETE FROM providerConnections").run();
  const names = forkDb.prepare("SELECT name FROM combos").all().map((r) => r.name).filter((n) => !KEEP.has(n));
  for (const n of names) forkDb.prepare("DELETE FROM combos WHERE name = ?").run(n);
  // History is rewritten whole: partially migrated rows carry unmapped connection ids.
  forkDb.prepare("DELETE FROM usageHistory").run();
  forkDb.prepare("DELETE FROM usageDaily").run();
  forkDb.prepare("UPDATE _meta SET value = '0' WHERE key = 'totalRequestsLifetime'").run();
  forkDb.close();
  report.reset = { deletedCombos: names.length };
}

const db = new Database(SRC, { readonly: true, fileMustExist: true });
db.pragma("busy_timeout = 5000");
const all = (sql, ...p) => db.prepare(sql).all(...p);

await initDb();

// ── 1. provider nodes ───────────────────────────────────────────────────────
const forkNodes = await getProviderNodes();
const nodeByPrefix = new Map(forkNodes.map((n) => [n.prefix, n.id]));
const nodeIdMap = new Map();

for (const n of all("SELECT * FROM provider_nodes")) {
  const existing = forkNodes.find((f) => f.id === n.id);
  if (existing) { nodeIdMap.set(n.id, n.id); continue; }
  await createProviderNode({
    id: n.id,
    type: n.type || "openai-compatible",
    name: n.name,
    prefix: n.prefix,
    apiType: n.api_type || "chat",
    baseUrl: n.base_url,
    iconUrl: n.icon_url || undefined,
  });
  nodeIdMap.set(n.id, n.id);
  nodeByPrefix.set(n.prefix, n.id);
  report.nodes++;
}

// ── 2. provider connections ─────────────────────────────────────────────────
// OmniRoute columns are snake_case; the fork's connection payload is camelCase.
const CARRY = {
  displayName: "display_name",
  defaultModel: "default_model",
  globalPriority: "global_priority",
  expiresAt: "expires_at",
  tokenType: "token_type",
  scope: "scope",
  projectId: "project_id",
  testStatus: "test_status",
  lastTested: "last_tested",
  lastError: "last_error",
  lastErrorAt: "last_error_at",
  rateLimitedUntil: "rate_limited_until",
  expiresIn: "expires_in",
  errorCode: "error_code",
  consecutiveUseCount: "consecutive_use_count",
  lastUsedAt: "last_used_at",
};
const SECRET_COLS = ["accessToken:access_token", "refreshToken:refresh_token", "apiKey:api_key", "idToken:id_token"];

const existingConns = await getProviderConnections();
// The fork mints its own connection ids, so dedupe on the OmniRoute id we stamp in.
const migratedSourceIds = new Set(existingConns.map((c) => c.sourceConnectionId).filter(Boolean));

// Direct writer used to stamp the source id (the repo drops unknown fields).
let stampDb = null;
function stampSourceId(forkId, sourceId) {
  if (!forkId) return;
  if (!stampDb) stampDb = new Database(process.env.DATA_DIR + "/db/data.sqlite");
  const row = stampDb.prepare("SELECT data FROM providerConnections WHERE id = ?").get(forkId);
  if (!row) return;
  const data = JSON.parse(row.data || "{}");
  data.sourceConnectionId = sourceId;
  stampDb.prepare("UPDATE providerConnections SET data = ? WHERE id = ?").run(JSON.stringify(data), forkId);
}

for (const r of all("SELECT * FROM provider_connections ORDER BY priority")) {
  if (migratedSourceIds.has(r.id)) { report.skipped.push(`connection ${r.id} already migrated`); continue; }

  let provider = mapProvider(r.provider);
  if (!KNOWN_PROVIDERS.has(provider) && !nodeIdMap.has(provider)) {
    const fbn = CUSTOM_FALLBACK_NODES[r.provider];
    if (!fbn) { report.skipped.push(`connection ${r.id}: provider ${r.provider} unknown to fork`); continue; }
    if (!nodeIdMap.has(fbn.id)) {
      await createProviderNode({ id: fbn.id, type: "openai-compatible", name: fbn.name, prefix: fbn.prefix, apiType: "chat", baseUrl: fbn.baseUrl });
      nodeIdMap.set(fbn.id, fbn.id);
      nodeByPrefix.set(fbn.prefix, fbn.id);
      report.nodes++;
      for (const m of fbn.models) await addCustomModel({ providerAlias: fbn.prefix, id: m.id, type: "llm", name: m.name });
    }
    provider = fbn.id;
  }

  const payload = { id: r.id, provider, authType: r.auth_type, name: r.name, email: r.email, priority: r.priority, isActive: r.is_active === 1, sourceConnectionId: r.id };
  for (const [field, col] of Object.entries(CARRY)) {
    if (r[col] !== null && r[col] !== undefined) payload[field] = r[col];
  }
  for (const pair of SECRET_COLS) {
    const [field, col] = pair.split(":");
    if (r[col]) payload[field] = decryptValue(r[col]);
  }
  const psd = parseMaybeJson(r.provider_specific_data);
  if (psd && typeof psd === "object") payload.providerSpecificData = psd;

  const created = await createProviderConnection(payload);
  connectionIdMap.set(r.id, created?.id || r.id);
  // The repo copies only its known fields, so stamp the source id with a direct write
  // (this is what makes a re-run able to skip an already-migrated connection).
  stampSourceId(created.id, r.id);
  report.connections++;
}

// Drop pins pointing at a connection that did not make it across.
const remapConnectionId = (oldId) => (oldId ? connectionIdMap.get(oldId) || null : null);

// ── 3. combos (expand combo-refs — this fork has no nested combos) ───────────
const comboRows = all("SELECT * FROM combos ORDER BY sort_order").map((r) => ({ ...r, parsed: JSON.parse(r.data) }));
const comboByName = new Map(comboRows.map((c) => [c.name, c]));

function expandModels(name, seen = new Set()) {
  const combo = comboByName.get(name);
  if (!combo) return [];
  if (seen.has(name)) return [];            // cycle guard
  seen.add(name);
  const out = [];
  for (const m of combo.parsed.models || []) {
    if (m.kind === "combo-ref") {
      out.push(...expandModels(m.comboName, new Set(seen)));
      continue;
    }
    const model = normalizeComboModelId(m.model);
    if (!model) continue;
    const pinned = remapConnectionId(m.connectionId);
    if (m.connectionId && !pinned) report.skipped.push(`combo ${name}: pin on missing connection dropped (${m.label || m.connectionId.slice(0, 8)})`);
    if (pinned) {
      out.push({ model, connectionId: pinned, ...(m.label ? { label: m.label } : {}) });
    } else {
      out.push(model);
    }
  }
  return out;
}

const STRATEGY_MAP = { priority: "fallback", "round-robin": "round-robin", weighted: "fallback" };
const forkCombos = await getCombos();
const existingComboNames = new Set(forkCombos.map((c) => c.name));
const comboStrategies = {};

for (const c of comboRows) {
  const models = expandModels(c.name);
  if (!models.length) { report.skipped.push(`combo ${c.name}: no resolvable models`); continue; }
  if (existingComboNames.has(c.name)) { report.skipped.push(`combo ${c.name} exists`); continue; }
  await createCombo({ name: c.name, models, kind: null });

  const strategy = STRATEGY_MAP[c.parsed.strategy] || "fallback";
  if (strategy !== "fallback" || (c.parsed.strategy && c.parsed.strategy !== "priority")) {
    comboStrategies[c.name] = { fallbackStrategy: strategy };
  }
  report.combos++;
}

// ── 4. model aliases + custom models ────────────────────────────────────────
const currentAliases = await getModelAliases();
for (const r of all("SELECT key, value FROM key_value WHERE namespace = 'modelAliases'")) {
  if (currentAliases[r.key]) { report.skipped.push(`alias ${r.key} exists`); continue; }
  const target = parseMaybeJson(r.value);
  if (typeof target !== "string") continue;
  await setModelAlias(r.key, target);
  report.aliases++;
}

// customModels in OmniRoute: key = provider id, value = list of model objects.
// The fork keys one row per model as `${providerAlias}|${id}|${type}`.
for (const r of all("SELECT key, value FROM key_value WHERE namespace = 'customModels'")) {
  const providerId = mapProvider(r.key);
  const alias = nodeByPrefix.has(providerId) ? null : getProviderAlias(providerId);
  const providerAlias = [...nodeByPrefix.entries()].find(([, id]) => id === providerId)?.[0] || alias || providerId;
  const list = parseMaybeJson(r.value);
  if (!Array.isArray(list)) continue;
  for (const m of list) {
    if (!m?.id) continue;
    await addCustomModel({ providerAlias, id: m.id, type: "llm", name: m.name || m.id });
    report.customModels++;
  }
}

// ── 5. settings we can honour ───────────────────────────────────────────────
const omniSettings = Object.fromEntries(
  all("SELECT key, value FROM key_value WHERE namespace = 'settings'").map((r) => [r.key, parseMaybeJson(r.value)])
);
const patch = {};
const providerStrategies = {};
for (const [pid, cfg] of Object.entries(omniSettings.providerStrategies || {})) {
  // Resolve the OmniRoute provider name to whatever it became here: a known
  // provider id, an imported node, or the fallback node we created.
  const fallback = CUSTOM_FALLBACK_NODES[pid];
  const candidate = mapProvider(pid);
  const target = nodeIdMap.has(candidate) ? candidate
    : (nodeByPrefix.has(candidate) ? nodeByPrefix.get(candidate) : null)
    || (fallback ? fallback.id : null);
  if (target && cfg?.fallbackStrategy) providerStrategies[target] = { fallbackStrategy: cfg.fallbackStrategy };
  else if (cfg?.fallbackStrategy) report.skipped.push(`provider strategy for unknown provider ${pid}`);
}
if (Object.keys(providerStrategies).length) patch.providerStrategies = providerStrategies;
{
  // Only keep strategy entries for combos that exist after this run.
  const live = new Set((await getCombos()).map((c) => c.name));
  const merged = { ...(await getSettings()).comboStrategies };
  for (const name of Object.keys(merged)) if (!live.has(name)) delete merged[name];
  patch.comboStrategies = { ...merged, ...comboStrategies };
}
if (Object.keys(patch).length) await updateSettings(patch);

// ── 6. usage history (+ daily rollups + lifetime counter via the fork) ──────
const usageRows = all(`
  SELECT timestamp, provider, model, connection_id, api_key_name, endpoint, status,
         tokens_input, tokens_output, tokens_cache_read, tokens_reasoning
  FROM usage_history ORDER BY timestamp ASC
`);
const chunk = [];
const flush = async () => {
  if (!chunk.length) return;
  for (const u of chunk) {
    await saveRequestUsage({
      timestamp: u.timestamp,
      provider: u.provider ? mapProvider(u.provider) : null,
      model: u.model || null,
      connectionId: remapConnectionId(u.connection_id),
      apiKey: u.api_key_name || null,
      endpoint: u.endpoint || null,
      status: u.status || "ok",
      cost: 0,
      tokens: {
        prompt_tokens: u.tokens_input || 0,
        completion_tokens: u.tokens_output || 0,
        ...(u.tokens_cache_read ? { cached_tokens: u.tokens_cache_read } : {}),
        ...(u.tokens_reasoning ? { reasoning_tokens: u.tokens_reasoning } : {}),
      },
    });
    report.usage++;
  }
  chunk.length = 0;
};
for (const u of usageRows) {
  chunk.push(u);
  if (chunk.length >= USAGE_CHUNK) await flush();
}
await flush();

db.close();
console.log(JSON.stringify(report, null, 2));
