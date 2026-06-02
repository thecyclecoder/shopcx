// Strip Gorgias-style tags from imported tickets, keep only ShopCX
// standard tags + the gorgias-import audit tag.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

// Whitelist: tags we actually use in ShopCX. Anything else gets stripped.
const KEEP_PREFIXES = ["ft:", "j:", "jr:", "w:", "ai:", "jo:", "dunning:", "pb:", "wb:", "crisis:"];
const KEEP_EXACT = new Set(["gorgias-import", "touched", "ai", "agent", "link", "pb", "wb", "crisis"]);

function isKept(tag) {
  if (KEEP_EXACT.has(tag)) return true;
  for (const p of KEEP_PREFIXES) if (tag.startsWith(p)) return true;
  return false;
}

const { data: tickets } = await admin
  .from("tickets")
  .select("id, subject, tags")
  .eq("workspace_id", W)
  .contains("tags", ["gorgias-import"]);

console.log(`Imported tickets: ${tickets?.length || 0}\n`);

let changed = 0;
for (const t of tickets || []) {
  const before = (t.tags || []);
  const after = before.filter(isKept);
  const removed = before.filter(x => !after.includes(x));
  if (removed.length === 0) {
    continue;
  }
  console.log(`${t.id.slice(0, 8)}  "${t.subject?.slice(0, 60)}"`);
  console.log(`  before: ${before.join(", ")}`);
  console.log(`  after:  ${after.join(", ")}`);
  console.log(`  removed: ${removed.join(", ")}`);
  console.log();
  changed++;
  if (APPLY) {
    await admin.from("tickets").update({ tags: after, updated_at: new Date().toISOString() }).eq("id", t.id);
  }
}

console.log(`${APPLY ? "✓" : "🔍 dry run —"} ${changed} ticket(s) ${APPLY ? "updated" : "would be updated"}.`);
if (!APPLY) console.log("Re-run with --apply.");
