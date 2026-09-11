"use client";

import { useState, useEffect, useMemo } from "react";
import Modal from "./Modal";
import Button from "./Button";
import ProviderIcon from "./ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { COMBO_STRATEGIES, DEFAULT_COMBO_STRATEGY, getComboStrategy } from "@/shared/constants/comboStrategies.js";
import { comboStepTarget, comboStepConnectionId, comboStepWeight } from "@/shared/utils/comboSteps.js";

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// The wizard's own member shape. Kept flat for editing, then converted to the
// stored form (a plain model string, or a step object) on save.
function toMembers(models) {
  return (models || []).map((entry) => {
    const target = comboStepTarget(entry);
    const slash = target.indexOf("/");
    return {
      provider: slash > 0 ? target.slice(0, slash) : "",
      model: slash > 0 ? target.slice(slash + 1) : target,
      connectionId: comboStepConnectionId(entry) || "",
      weight: comboStepWeight(entry),
      hasWeight: entry && typeof entry === "object" && entry.weight !== undefined,
    };
  });
}

function toStored(members) {
  return members.map((m) => {
    // A model id may itself contain a slash (provider "cmd", model "deepseek/x"),
    // so the provider is always prefixed; it is the one the picker supplied.
    const target = `${m.provider}/${m.model}`;
    // No pin and no weight → plain string, so old readers keep working.
    if (!m.connectionId && !m.hasWeight) return target;
    const step = { model: target };
    if (m.connectionId) step.connectionId = m.connectionId;
    if (m.hasWeight) step.weight = m.weight;
    return step;
  });
}

const STEPS = ["Basics", "Steps", "Strategy", "Review"];

export default function ComboBuilder({ isOpen, combo, onClose, onSave, comboStrategy }) {
  const isEdit = !!combo;
  // The parent remounts this component per combo (key=...), so initial state can be
  // derived from props directly — no reset effect needed.
  const [step, setStep] = useState(0);
  const [name, setName] = useState(combo?.name || "");
  const [members, setMembers] = useState(() => toMembers(combo?.models));
  const [strategy, setStrategy] = useState(comboStrategy || DEFAULT_COMBO_STRATEGY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [connections, setConnections] = useState([]);
  const [models, setModels] = useState([]);
  const [picker, setPicker] = useState(null);   // index of the member whose pickers are open

  // Pickers need the account and model lists. Pinned by the effect, so a slow fetch
  // never blocks opening the wizard.
  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/providers").then((r) => r.ok ? r.json() : null)
      .then((d) => setConnections((d?.connections || []).filter((c) => c.isActive !== false)))
      .catch(() => {});
    fetch("/api/models").then((r) => r.ok ? r.json() : null)
      .then((d) => setModels(d?.models || []))
      .catch(() => {});
  }, [isOpen]);

  // Models grouped by provider id, in registry order.
  const modelsByProvider = useMemo(() => {
    const map = new Map();
    for (const m of models) {
      if (!map.has(m.provider)) map.set(m.provider, []);
      map.get(m.provider).push(m);
    }
    return map;
  }, [models]);

  const accountsByProvider = useMemo(() => {
    const map = new Map();
    for (const c of connections) {
      if (!c?.provider || !c?.id) continue;
      if (!map.has(c.provider)) map.set(c.provider, []);
      map.get(c.provider).push(c);
    }
    return map;
  }, [connections]);

  const providers = useMemo(() => [...modelsByProvider.keys()].sort(), [modelsByProvider]);
  const accountLabel = (c) => c.name || c.email || c.id?.slice(0, 8) || "unnamed";
  const providerLabel = (id) => AI_PROVIDERS[id]?.name || id;

  // ── member edits ──────────────────────────────────────────────────────────
  const patchMember = (index, patch) => {
    setMembers((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  };
  const addMember = () => {
    setMembers((prev) => {
      const next = [...prev, { provider: "", model: "", connectionId: "", weight: 1, hasWeight: false }];
      setPicker(next.length - 1);
      return next;
    });
  };
  const removeMember = (index) => setMembers((prev) => prev.filter((_, i) => i !== index));
  const duplicateMember = (index) => {
    setMembers((prev) => {
      const next = [...prev];
      next.splice(index + 1, 0, { ...prev[index], connectionId: "" });
      return next;
    });
  };
  const moveMember = (index, dir) => {
    setMembers((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const validateName = (value) => {
    if (!value.trim()) return "Name is required";
    if (!VALID_NAME_REGEX.test(value.trim())) return "Only letters, numbers, -, _ and . allowed";
    return "";
  };

  const validate = () => {
    const nameErr = validateName(name);
    if (nameErr) return nameErr;
    if (members.length === 0) return "Add at least one step.";
    if (members.some((m) => !m.provider || !m.model)) return "Every step needs a provider and a model.";
    return "";
  };

  const handleSave = async () => {
    const err = validate();
    if (err) { setError(err); setStep(err.startsWith("Add") || err.startsWith("Every") ? 1 : 0); return; }
    setSaving(true);
    setError("");
    try {
      await onSave({ name: name.trim(), models: toStored(members), strategy });
    } finally {
      setSaving(false);
    }
  };

  const canNext = step === 0 ? !validateName(name) : step === 1 ? members.length > 0 && members.every((m) => m.provider && m.model) : true;
  const strategyMeta = getComboStrategy(strategy);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={isEdit ? `Edit Combo — ${combo?.name || ""}` : "Create Combo"}>
      <div className="flex flex-col gap-4" data-testid="combo-builder">
        {/* Step indicator */}
        <div className="flex items-center gap-1.5">
          {STEPS.map((label, i) => (
            <div key={label} className="flex min-w-0 flex-1 items-center gap-1.5">
              <button
                onClick={() => i < step && setStep(i)}
                disabled={i > step}
                className={`flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 text-[11px] transition-colors ${
                  i === step ? "bg-primary/15 text-primary font-medium"
                    : i < step ? "text-text-muted hover:text-primary"
                    : "text-text-muted/50"
                }`}
              >
                <span className={`grid size-4 shrink-0 place-items-center rounded-full text-[9px] ${
                  i === step ? "bg-primary text-white" : i < step ? "bg-primary/30 text-primary" : "bg-black/10 dark:bg-white/10"
                }`}>{i + 1}</span>
                <span className="truncate">{label}</span>
              </button>
              {i < STEPS.length - 1 && <span className="h-px min-w-2 flex-1 bg-black/10 dark:bg-white/10" />}
            </div>
          ))}
        </div>

        <div className="flex max-h-[60vh] min-h-[240px] flex-col gap-3 overflow-y-auto pr-0.5">
          {/* ── 1. Basics ── */}
          {step === 0 && (
            <>
              <div>
                <label className="text-sm font-medium mb-1 block">Combo Name</label>
                <input
                  autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-combo"
                  className="w-full rounded border border-black/10 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1.5 font-mono text-sm outline-none focus:border-primary"
                />
                <p className="text-[10px] text-text-muted mt-0.5">Only letters, numbers, -, _ and . allowed</p>
              </div>
              <p className="text-xs text-text-muted">
                A combo is a named list of models. Send the combo name as the model and the router walks the list.
                Each step can pin one provider account.
              </p>
            </>
          )}

          {/* ── 2. Steps ── */}
          {step === 1 && (
            <>
              {members.length === 0 && (
                <div className="text-center py-6 border border-dashed border-black/10 dark:border-white/10 rounded-lg">
                  <span className="material-symbols-outlined text-text-muted text-xl">layers</span>
                  <p className="text-xs text-text-muted mt-1">No steps yet</p>
                </div>
              )}
              {members.map((m, index) => (
                <div key={index} className="rounded-lg border border-black/10 dark:border-white/10 p-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-text-muted w-3 text-center shrink-0">{index + 1}</span>
                    {m.provider
                      ? <ProviderIcon src={`/providers/${m.provider}.png`} alt={m.provider} size={16}
                          fallbackText={AI_PROVIDERS[m.provider]?.textIcon || m.provider.slice(0, 2).toUpperCase()}
                          fallbackColor={AI_PROVIDERS[m.provider]?.color} />
                      : <span className="material-symbols-outlined text-[16px] text-text-muted">help</span>}
                    <div className="min-w-0 flex-1 truncate font-mono text-xs">
                      {m.provider ? `${m.provider}/${m.model}` : "Pick a provider and model"}
                    </div>
                    {m.connectionId && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-primary shrink-0">
                        <span className="material-symbols-outlined text-[12px]">account_circle</span>
                        {accountLabel(connections.find((c) => c.id === m.connectionId) || { id: m.connectionId })}
                      </span>
                    )}
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button onClick={() => setPicker(picker === index ? null : index)} className="p-0.5 rounded text-text-muted hover:text-primary hover:bg-black/5" title="Change provider, model or account">
                        <span className="material-symbols-outlined text-[13px]">edit</span>
                      </button>
                      <button onClick={() => duplicateMember(index)} className="p-0.5 rounded text-text-muted hover:text-primary hover:bg-black/5" title="Duplicate on another account">
                        <span className="material-symbols-outlined text-[13px]">content_copy</span>
                      </button>
                      <button onClick={() => moveMember(index, -1)} disabled={index === 0} className={`p-0.5 rounded ${index === 0 ? "text-text-muted/20" : "text-text-muted hover:text-primary hover:bg-black/5"}`} title="Move up">
                        <span className="material-symbols-outlined text-[13px]">arrow_upward</span>
                      </button>
                      <button onClick={() => moveMember(index, 1)} disabled={index === members.length - 1} className={`p-0.5 rounded ${index === members.length - 1 ? "text-text-muted/20" : "text-text-muted hover:text-primary hover:bg-black/5"}`} title="Move down">
                        <span className="material-symbols-outlined text-[13px]">arrow_downward</span>
                      </button>
                      <button onClick={() => removeMember(index)} className="p-0.5 rounded text-text-muted hover:text-red-500 hover:bg-red-500/10" title="Remove">
                        <span className="material-symbols-outlined text-[13px]">close</span>
                      </button>
                    </div>
                  </div>

                  {picker === index && (
                    <div className="mt-2 flex flex-col gap-1.5 border-t border-black/5 dark:border-white/5 pt-2">
                      <select
                        value={m.provider}
                        onChange={(e) => patchMember(index, { provider: e.target.value, model: "", connectionId: "" })}
                        className="rounded border border-black/10 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1 text-xs outline-none focus:border-primary"
                      >
                        <option value="">Select provider…</option>
                        {providers.map((p) => <option key={p} value={p}>{providerLabel(p)}</option>)}
                      </select>

                      <select
                        value={m.model} disabled={!m.provider}
                        onChange={(e) => patchMember(index, { model: e.target.value })}
                        className="rounded border border-black/10 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1 text-xs outline-none focus:border-primary disabled:opacity-50"
                      >
                        <option value="">{m.provider ? "Select model…" : "Pick a provider first"}</option>
                        {(modelsByProvider.get(m.provider) || []).map((mm) => (
                          <option key={mm.routedModel || mm.model} value={mm.model}>{mm.name || mm.model}</option>
                        ))}
                      </select>

                      <select
                        value={m.connectionId}
                        onChange={(e) => patchMember(index, { connectionId: e.target.value })}
                        className="rounded border border-black/10 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1 text-xs outline-none focus:border-primary"
                        title="Which account this step must use"
                      >
                        <option value="">Auto — any active account</option>
                        {(accountsByProvider.get(m.provider) || []).map((c) => (
                          <option key={c.id} value={c.id}>{accountLabel(c)}</option>
                        ))}
                      </select>
                      {(accountsByProvider.get(m.provider) || []).length === 0 && m.provider && (
                        <p className="text-[10px] text-text-muted">No account registered for {providerLabel(m.provider)} — the step will use the pool.</p>
                      )}

                      <label className="flex items-center gap-2 text-[11px] text-text-muted">
                        <input type="checkbox" checked={m.hasWeight} onChange={(e) => patchMember(index, { hasWeight: e.target.checked, weight: m.weight || 1 })} />
                        Set a weight for the Weighted strategy
                      </label>
                      {m.hasWeight && (
                        <input
                          type="number" min="0.1" step="0.1" value={m.weight}
                          onChange={(e) => patchMember(index, { weight: Number(e.target.value) })}
                          className="w-24 rounded border border-black/10 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1 text-xs outline-none focus:border-primary"
                        />
                      )}
                    </div>
                  )}
                </div>
              ))}
              <button onClick={addMember}
                className="w-full py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:border-primary/50 flex items-center justify-center gap-1">
                <span className="material-symbols-outlined text-[16px]">add</span>
                Add step
              </button>
              <p className="text-[10px] text-text-muted">
                Steps are tried in this order. Pin an account to force a step onto one provider account; leave it on Auto to spread across the pool.
              </p>
            </>
          )}

          {/* ── 3. Strategy ── */}
          {step === 2 && (
            <>
              <div className="flex flex-col gap-1.5">
                {COMBO_STRATEGIES.map((s) => (
                  <button
                    key={s.value} onClick={() => setStrategy(s.value)}
                    className={`flex items-start gap-2 rounded-lg border p-2 text-left transition-colors ${
                      strategy === s.value ? "border-primary bg-primary/5" : "border-black/10 dark:border-white/10 hover:border-primary/40"
                    }`}
                  >
                    <span className={`material-symbols-outlined text-[18px] mt-0.5 ${strategy === s.value ? "text-primary" : "text-text-muted"}`}>{s.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{s.label}</span>
                      <span className="block text-[11px] text-text-muted">{s.desc}</span>
                      <span className="block text-[10px] text-text-muted/80 mt-0.5">Use when: {s.when}</span>
                    </span>
                    {strategy === s.value && <span className="material-symbols-outlined text-[16px] text-primary">check_circle</span>}
                  </button>
                ))}
              </div>
              {strategy === "fusion" && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  Fusion sends one request per step plus a judge call. Cost and latency multiply by the number of steps.
                </p>
              )}
            </>
          )}

          {/* ── 4. Review ── */}
          {step === 3 && (
            <>
              <div className="rounded-lg border border-black/10 dark:border-white/10 p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-text-muted">Name</span>
                  <code className="font-mono text-sm">{name}</code>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-text-muted">Strategy</span>
                  <span className="text-sm">{strategyMeta?.label}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-text-muted">Steps ({members.length})</span>
                  {members.map((m, i) => (
                    <div key={i} className="flex items-center gap-1.5 font-mono text-[11px]">
                      <span className="text-text-muted">{i + 1}.</span>
                      <span className="truncate">{m.provider}/{m.model}</span>
                      {m.connectionId && (
                        <span className="text-primary shrink-0">
                          @{accountLabel(connections.find((c) => c.id === m.connectionId) || { id: m.connectionId })}
                        </span>
                      )}
                      {m.hasWeight && <span className="text-text-muted shrink-0">w={m.weight}</span>}
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg bg-black/[0.02] dark:bg-white/[0.02] p-2 text-[11px] text-text-muted">
                <div className="flex items-center gap-1">
                  <span className={`material-symbols-outlined text-[13px] ${validateName(name) ? "text-red-500" : "text-green-500"}`}>
                    {validateName(name) ? "cancel" : "check_circle"}
                  </span>
                  A valid combo name
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className={`material-symbols-outlined text-[13px] ${members.length > 0 ? "text-green-500" : "text-red-500"}`}>
                    {members.length > 0 ? "check_circle" : "cancel"}
                  </span>
                  At least one step
                </div>
              </div>
            </>
          )}
        </div>

        {error && <p className="text-[11px] text-red-500">{error}</p>}

        {/* Wizard navigation */}
        <div className="flex items-center gap-2 pt-1">
          {step > 0 && (
            <Button onClick={() => setStep(step - 1)} variant="ghost" size="sm">
              <span className="material-symbols-outlined text-[15px]">arrow_back</span>
              Back
            </Button>
          )}
          <div className="flex-1" />
          <Button onClick={onClose} variant="ghost" size="sm">Cancel</Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep(step + 1)} size="sm" disabled={!canNext}>
              Next
              <span className="material-symbols-outlined text-[15px]">arrow_forward</span>
            </Button>
          ) : (
            <Button onClick={handleSave} size="sm" disabled={saving || !!validateName(name) || members.length === 0}>
              {saving ? "Saving…" : isEdit ? "Save" : "Create"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
