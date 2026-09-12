/**
 * Model-id spelling differences between OmniRoute and this fork.
 *
 * OmniRoute names an effort-suffixed model `model-max` / `model-high`; this fork
 * spells the same thing `model(max)`, and only the parenthesised form reaches
 * upstream as the effort-reduced model id (a dash-suffixed id is forwarded
 * verbatim and rejected by the provider).
 *
 * The rule consults the provider's registry list, never `isValidModel`: that
 * helper returns true for every id of a passthrough provider (opencode-go among
 * them), which is exactly the case this has to catch.
 */
import { getProviderAlias } from "../../src/shared/constants/providers.js";
import { getProviderModels } from "../../src/shared/constants/models.js";

const EFFORT_SUFFIXES = ["max", "xhigh", "high", "medium", "low", "minimal", "none"];

function registryIds(model) {
  const slash = model.indexOf("/");
  if (slash < 0) return null;
  const provider = model.slice(0, slash);
  // Registry lists are keyed by provider id ("opencode-go"); the dashboard alias
  // ("ocg") has none, so try both and take whichever is populated.
  const candidates = [getProviderModels(provider), getProviderModels(getProviderAlias(provider) || provider)];
  const models = candidates.find((list) => Array.isArray(list) && list.length);
  if (!models) return null;
  return new Set(models.map((m) => m.id));
}

/**
 * Rewrite a combo member's model id into the form this fork dispatches.
 * Unchanged unless the id is unknown to the provider while its dash-stripped
 * base is known — so real ids that merely end in a level word (qwen3.8-max)
 * survive untouched.
 *
 * @param {string} model - `providerAlias/modelId`
 * @returns {string} the model id to store
 */
export function normalizeComboModelId(model) {
  if (typeof model !== "string" || !model) return model;
  const ids = registryIds(model);
  if (!ids || ids.has(model.slice(model.indexOf("/") + 1))) return model;
  for (const level of EFFORT_SUFFIXES) {
    const suffix = `-${level}`;
    if (!model.endsWith(suffix)) continue;
    const base = model.slice(0, -suffix.length);
    if (ids.has(base.slice(base.indexOf("/") + 1))) return `${base}(${level})`;
  }
  return model;
}
