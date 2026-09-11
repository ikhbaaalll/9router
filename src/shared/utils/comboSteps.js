/**
 * Combo step helpers.
 *
 * A combo member is either the legacy `"provider/model"` string or a step object
 * that can also pin WHICH ACCOUNT (provider connection) the step must use:
 *
 *   "cmd/deepseek/deepseek-v4-flash"                                    // pool/auto
 *   { model: "cmd/deepseek/deepseek-v4-flash", connectionId: "<id>" }   // pinned account
 *   { provider: "cmd", model: "deepseek/deepseek-v4-flash", connectionId: "<id>" }
 *
 * The object form is a port of OmniRoute's combo step schema
 * (`src/shared/validation/schemas/combo.ts` → `comboModelStepInputSchema`), so a
 * combo created here keeps the same shape when it moves between the two gateways.
 * Ported fields: `model`, `provider`, `connectionId`, `label`.
 *
 * Dependency-free on purpose: imported by the open-sse engine (server) and by the
 * dashboard components (client bundle).
 */

/**
 * Resolve a step to its `"provider/model"` string. Legacy strings pass through.
 * @param {string|Object} entry - Combo member (string or step object)
 * @returns {string} Model string, or "" when the entry is unusable
 */
export function comboStepTarget(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";

  const model = typeof entry.model === "string" ? entry.model.trim() : "";
  if (!model) return "";

  // Join provider+model only when the model has no slash of its own: 9router model
  // ids may contain slashes (provider "cmd", model "deepseek/deepseek-v4-flash"),
  // and re-joining those would corrupt the target.
  const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
  if (provider && !model.includes("/")) return `${provider}/${model}`;
  return model;
}

/**
 * Connection (account) id a step is pinned to.
 * @param {string|Object} entry - Combo member
 * @returns {string|null} Connection id, or null for "let the pool decide"
 */
export function comboStepConnectionId(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const id = typeof entry.connectionId === "string" ? entry.connectionId.trim() : "";
  return id || null;
}

/**
 * Human-readable label for a step: the model string, plus the pinned account when
 * one is set. Used by the dashboard and by request logs.
 * @param {string|Object} entry - Combo member
 * @returns {string} e.g. `cmd/deepseek/deepseek-v4-flash @work-account`
 */
export function comboStepDisplay(entry) {
  const target = comboStepTarget(entry);
  const connectionId = comboStepConnectionId(entry);
  if (!connectionId) return target;

  const label = (typeof entry?.label === "string" && entry.label.trim()) ||
    connectionId.slice(0, 8);
  return `${target} @${label}`;
}

/**
 * Weight of a step, used by the "weighted" strategy. Legacy strings weigh 1.
 * @param {string|Object} entry - Combo member
 * @returns {number} Positive weight, or 1 when unset/invalid
 */
export function comboStepWeight(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return 1;
  const weight = Number(entry.weight);
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

/**
 * Normalize one step for storage. Keeps legacy strings, drops unknown fields, and
 * drops empty account pins (an empty pin means "auto").
 * @param {string|Object} entry - Raw combo member from a request body
 * @returns {string|Object|null} Storable entry, or null when unusable
 */
export function normalizeComboStep(entry) {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    return trimmed || null;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const target = comboStepTarget(entry);
  if (!target) return null;

  const connectionId = comboStepConnectionId(entry);
  const label = typeof entry.label === "string" ? entry.label.trim() : "";
  const weight = entry.weight === undefined ? null : comboStepWeight(entry);

  // Nothing pinned and no weight → store the plain string so old readers keep working.
  if (!connectionId && weight === null) return target;

  return {
    model: target,
    ...(connectionId ? { connectionId } : {}),
    ...(label ? { label } : {}),
    ...(weight !== null ? { weight } : {}),
  };
}

/**
 * Normalize a whole combo member list for storage.
 * @param {Array} models - Raw combo members
 * @returns {{models: Array, error: string|null}} Normalized list, or an error message
 */
export function normalizeComboSteps(models) {
  if (!Array.isArray(models)) return { models: [], error: "models must be an array" };

  const out = [];
  for (const entry of models) {
    const step = normalizeComboStep(entry);
    if (!step) return { models: [], error: "each model must be a name or { model, connectionId }" };
    out.push(step);
  }
  return { models: out, error: null };
}
