// One-off: rewrite combo member model ids from OmniRoute's dash-effort spelling
// ("deepseek-v4-flash-max") to this fork's ("deepseek-v4-flash(max)").
// Reads/writes the fork DB directly so combo ids and everything else stay put.
import Database from "better-sqlite3";
import { normalizeComboModelId } from "./lib/normalizeComboModelId.mjs";

const DB = process.env.DATA_DIR ? `${process.env.DATA_DIR}/db/data.sqlite` : "/home/wdftr/.9router-fork/db/data.sqlite";
const db = new Database(DB);

const rows = db.prepare("SELECT id, name, models FROM combos").all();
let changed = 0;

const update = db.prepare("UPDATE combos SET models = ? WHERE id = ?");
const apply = db.transaction((items) => {
  for (const { id, models } of items) update.run(models, id);
});

const pending = [];
for (const row of rows) {
  const before = JSON.parse(row.models);
  const after = before.map((m) =>
    typeof m === "string" ? normalizeComboModelId(m) : { ...m, model: normalizeComboModelId(m.model) },
  );
  if (JSON.stringify(before) === JSON.stringify(after)) continue;
  const pairs = before
    .map((m, i) => [typeof m === "string" ? m : m.model, typeof after[i] === "string" ? after[i] : after[i].model])
    .filter(([a, b]) => a !== b);
  console.log(`FIXED ${row.name}: ${JSON.stringify(pairs)}`);
  pending.push({ id: row.id, models: JSON.stringify(after) });
  changed++;
}

if (process.argv.includes("--apply")) {
  apply(pending);
  console.log(`applied to ${pending.length} combo(s)`);
} else {
  console.log(`dry run: ${changed} combo(s) would change — pass --apply to write`);
}
db.close();
