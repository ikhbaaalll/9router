"use client";

import { useState, useEffect, useMemo } from "react";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import Modal from "./Modal";
import Input from "./Input";
import Button from "./Button";
import ModelSelectModal from "./ModelSelectModal";
import { comboStepTarget, comboStepConnectionId } from "@/shared/utils/comboSteps.js";

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// Display name for an account row (name → email → short id).
function connectionLabel(conn) {
  return conn.name || conn.email || conn.id?.slice(0, 8) || "unnamed";
}

// A combo member is a model string, or a step object when an account is pinned:
// { model: "provider/model", connectionId, label }. These two helpers rewrite one
// field without dropping the other.
function withTarget(entry, target) {
  const connectionId = comboStepConnectionId(entry);
  if (!connectionId) return target;
  const label = typeof entry?.label === "string" ? entry.label : "";
  return { model: target, connectionId, ...(label ? { label } : {}) };
}

function withConnection(entry, connectionId, label) {
  const target = comboStepTarget(entry);
  if (!connectionId) return target;
  return { model: target, connectionId, ...(label ? { label } : {}) };
}

// One combo member row: drag to reorder, inline-edit the model, pick the account.
function ModelItem({ id, index, entry, accounts, isFirst, isLast, onEdit, onAccountChange, onDuplicate, onMoveUp, onMoveDown, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    // no transition — prevents the CSS settle animation fighting React's re-render on drop
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 999 : undefined,
  };
  const [editing, setEditing] = useState(false);
  const model = comboStepTarget(entry);
  const pinnedConnectionId = comboStepConnectionId(entry) || "";
  const [draft, setDraft] = useState(model);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };
  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setDraft(model); setEditing(false); }
  };

  // Accounts belong to a provider, so a pin only makes sense while the provider holds.
  const pinnedMissing = pinnedConnectionId && !accounts.some((a) => a.id === pinnedConnectionId);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex min-w-0 flex-col gap-1 rounded-md bg-black/[0.02] px-2 py-1 transition-colors hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04] ${isDragging ? "shadow-md ring-1 ring-primary/30" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {/* Drag handle */}
        <button
          {...attributes}
          {...listeners}
          type="button"
          className="cursor-grab touch-none p-0.5 rounded text-text-muted hover:text-primary active:cursor-grabbing shrink-0"
          title="Drag to reorder"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="4" r="2"/><circle cx="15" cy="4" r="2"/>
            <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
            <circle cx="9" cy="20" r="2"/><circle cx="15" cy="20" r="2"/>
          </svg>
        </button>
        <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">{index + 1}</span>
        {editing ? (
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={handleKeyDown}
            className="min-w-0 flex-1 rounded border border-primary/40 bg-white px-1.5 py-0.5 font-mono text-xs text-text-main outline-none dark:bg-black/20" />
        ) : (
          <div className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5"
            onClick={() => setEditing(true)} title="Click to edit">{model}</div>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <button onClick={onDuplicate} className="p-0.5 rounded text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5" title="Duplicate (same model, other account)">
            <span className="material-symbols-outlined text-[12px]">content_copy</span>
          </button>
          <button onClick={onMoveUp} disabled={isFirst}
            className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`} title="Move up">
            <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
          </button>
          <button onClick={onMoveDown} disabled={isLast}
            className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`} title="Move down">
            <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
          </button>
        </div>
        <button onClick={onRemove} className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all" title="Remove">
          <span className="material-symbols-outlined text-[12px]">close</span>
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-1.5 pl-[18px]">
        <span className="material-symbols-outlined text-[12px] text-text-muted shrink-0">account_circle</span>
        <select
          value={pinnedConnectionId}
          onChange={(e) => {
            const id = e.target.value;
            const account = accounts.find((a) => a.id === id);
            onAccountChange(id, account ? connectionLabel(account) : "");
          }}
          className="min-w-0 flex-1 rounded border border-black/10 dark:border-white/10 bg-white dark:bg-black/20 px-1.5 py-0.5 text-[11px] text-text-main outline-none focus:border-primary"
          title="Which account of this provider the combo member must use"
        >
          <option value="">Auto — any active account</option>
          {pinnedMissing && <option value={pinnedConnectionId}>{pinnedConnectionId.slice(0, 8)} (missing)</option>}
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>{connectionLabel(account)}</option>
          ))}
        </select>
        {accounts.length === 0 && (
          <span className="text-[10px] text-text-muted shrink-0" title="No account registered for this provider">no accounts</span>
        )}
      </div>
    </div>
  );
}

// Reusable Combo create/edit modal. forcePrefix auto-prepends to name.
export default function ComboFormModal({ isOpen, combo, onClose, onSave, activeProviders, kindFilter = null, forcePrefix = "", title }) {
  // Strip prefix when editing existing combo so user only edits suffix
  const initialName = combo?.name
    ? (forcePrefix && combo.name.startsWith(forcePrefix) ? combo.name.slice(forcePrefix.length) : combo.name)
    : "";
  const [name, setName] = useState(initialName);
  const [models, setModels] = useState(combo?.models || []);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [modelAliases, setModelAliases] = useState({});
  const [connections, setConnections] = useState([]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Stable index-based IDs so duplicates and similar names are handled correctly.
  const modelItems = models.map((entry, i) => ({ uid: `item-${i}`, entry }));

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = modelItems.findIndex((m) => m.uid === active.id);
      const newIndex = modelItems.findIndex((m) => m.uid === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        setModels((prev) => arrayMove(prev, oldIndex, newIndex));
      }
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/models/alias").then((r) => r.ok ? r.json() : null).then((d) => d && setModelAliases(d.aliases || {})).catch(() => {});
    // Accounts offered per combo member. Fail-open: no list → "Auto" only.
    fetch("/api/providers").then((r) => r.ok ? r.json() : null)
      .then((d) => setConnections((d?.connections || []).filter((c) => c.isActive !== false)))
      .catch(() => {});
  }, [isOpen]);

  // Accounts grouped by provider id, so one row only offers its own provider's accounts.
  const accountsByProvider = useMemo(() => {
    const map = {};
    for (const conn of connections) {
      if (!conn?.provider || !conn?.id) continue;
      (map[conn.provider] ||= []).push(conn);
    }
    return map;
  }, [connections]);

  const accountsFor = (entry) => {
    const target = comboStepTarget(entry);
    const slash = target.indexOf("/");
    const provider = slash > 0 ? target.slice(0, slash) : "";
    return provider ? (accountsByProvider[provider] || []) : [];
  };

  const validateName = (value) => {
    if (!value.trim()) { setNameError("Name is required"); return false; }
    const full = forcePrefix + value;
    if (!VALID_NAME_REGEX.test(full)) { setNameError("Only letters, numbers, -, _ and . allowed"); return false; }
    setNameError("");
    return true;
  };

  const handleNameChange = (e) => {
    let value = e.target.value;
    // If user types prefix manually, strip it (we always prepend)
    if (forcePrefix && value.startsWith(forcePrefix)) value = value.slice(forcePrefix.length);
    setName(value);
    if (value) validateName(value); else setNameError("");
  };

  const handleAddModel = (model) => {
    if (!models.some((m) => comboStepTarget(m) === model.value)) setModels([...models, model.value]);
  };
  const handleDeselectModel = (model) => {
    setModels(models.filter((m) => comboStepTarget(m) !== model.value));
  };
  const handleRemoveModel = (i) => setModels(models.filter((_, idx) => idx !== i));
  const handleEditModel = (i, target) => {
    const a = [...models];
    const pinned = comboStepConnectionId(a[i]);
    const pinnedAccount = pinned ? accountsFor(a[i]).find((c) => c.id === pinned) : null;
    const slash = target.indexOf("/");
    const newProvider = slash > 0 ? target.slice(0, slash) : "";
    // Keep the pin only while the edited model stays on the pinned account's provider.
    a[i] = pinnedAccount && newProvider === pinnedAccount.provider ? withTarget(a[i], target) : target;
    setModels(a);
  };
  const handleAccountChange = (i, connectionId, label) => {
    const a = [...models];
    a[i] = withConnection(a[i], connectionId, label);
    setModels(a);
  };
  const handleDuplicate = (i) => {
    const a = [...models];
    a.splice(i + 1, 0, a[i]);
    setModels(a);
  };
  const handleMoveUp = (i) => {
    if (i === 0) return;
    const a = [...models]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; setModels(a);
  };
  const handleMoveDown = (i) => {
    if (i === models.length - 1) return;
    const a = [...models]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; setModels(a);
  };

  const handleSave = async () => {
    if (!validateName(name)) return;
    setSaving(true);
    await onSave({ name: forcePrefix + name.trim(), models });
    setSaving(false);
  };

  const isEdit = !!combo;

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title={title || (isEdit ? "Edit Combo" : "Create Combo")}>
        <div className="flex flex-col gap-3">
          <div>
            {forcePrefix ? (
              <>
                <label className="text-sm font-medium mb-1 block">Combo Name</label>
                <div className="flex items-stretch">
                  <span className="inline-flex items-center px-2 rounded-l border border-r-0 border-black/10 dark:border-white/10 bg-black/[0.04] dark:bg-white/[0.04] text-text-muted font-mono text-sm">{forcePrefix}</span>
                  <input value={name} onChange={handleNameChange} placeholder="my-combo"
                    className="flex-1 min-w-0 rounded-r border border-black/10 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1.5 font-mono text-sm outline-none focus:border-primary" />
                </div>
                {nameError && <p className="text-[11px] text-red-500 mt-0.5">{nameError}</p>}
              </>
            ) : (
              <Input label="Combo Name" value={name} onChange={handleNameChange} placeholder="my-combo" error={nameError} />
            )}
            <p className="text-[10px] text-text-muted mt-0.5">
              {forcePrefix ? `Auto-prefixed with "${forcePrefix}". ` : ""}Only letters, numbers, -, _ and . allowed
            </p>
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">Models</label>
            {models.length === 0 ? (
              <div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                <span className="material-symbols-outlined text-text-muted text-xl mb-1">layers</span>
                <p className="text-xs text-text-muted">No models added yet</p>
              </div>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
                <SortableContext items={modelItems.map((m) => m.uid)} strategy={verticalListSortingStrategy}>
                  <div className="flex max-h-[55vh] min-w-0 flex-col gap-1 overflow-y-auto sm:max-h-[350px]">
                    {modelItems.map(({ uid, entry }, index) => (
                      <ModelItem key={uid} id={uid} index={index} entry={entry}
                        accounts={accountsFor(entry)}
                        isFirst={index === 0} isLast={models.length - 1}
                        onEdit={(v) => handleEditModel(index, v)}
                        onAccountChange={(connectionId, label) => handleAccountChange(index, connectionId, label)}
                        onDuplicate={() => handleDuplicate(index)}
                        onMoveUp={() => handleMoveUp(index)}
                        onMoveDown={() => handleMoveDown(index)}
                        onRemove={() => handleRemoveModel(index)} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
            <p className="text-[10px] text-text-muted mt-1">
              Pick an account to pin a member to one provider account — leave it on Auto to spread requests across the pool.
            </p>
            <button onClick={() => setShowModelSelect(true)}
              className="w-full mt-2 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1">
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add Model
            </button>
          </div>

          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={onClose} variant="ghost" fullWidth size="sm">Cancel</Button>
            <Button onClick={handleSave} fullWidth size="sm" disabled={!name.trim() || !!nameError || saving}>
              {saving ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      {showModelSelect && (
        <ModelSelectModal isOpen={showModelSelect} onClose={() => setShowModelSelect(false)}
          onSelect={handleAddModel} onDeselect={handleDeselectModel}
          activeProviders={activeProviders} modelAliases={modelAliases}
          title="Add Model to Combo" kindFilter={kindFilter}
          addedModelValues={models.map(comboStepTarget)} closeOnSelect={false} />
      )}
    </>
  );
}
