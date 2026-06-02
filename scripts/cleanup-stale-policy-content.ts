/**
 * Clean up content surfaces that duplicate or conflict with the new
 * `policies` table:
 *   1. Stale macros — deactivate ones that paraphrase policy with OUT OF DATE
 *      wording (e.g. "48 hour cancellation notice", separate "Return Policy"
 *      macro, etc.). They get pulled by the RAG retriever and could leak
 *      stale policy back into customer messages.
 *   2. `[rule] Pause action: 30 or 60 days only` — pure policy, fold.
 *   3. `playbook_policies` row "30-Day Return Policy" on the Refund playbook
 *      — replace description with a pointer at the canonical policies row.
 *
 * Macros are deactivated (active=false), not deleted, so we keep history
 * and can restore. Pure policy duplicates with [FOLDED] prefix where we
 * keep them around for audit.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// Macros to deactivate — they duplicate policy content with stale wording
// that would conflict with the policies table if pulled by RAG.
const STALE_MACRO_NAMES = [
  "Return Policy - 30 Day Money Back Guarantee",       // Old: no first-order-only constraint
  "Subscription Policy",                                // Old: "48 hour cancellation notice"
  "Replacement Policy",                                 // Old: separate content; in exchanges policy now
  "Refund - Post 30 Day (48 Hour Policy)",              // Stale 48h language
  "All Products - Subscription vs. One-Time",           // Has stale "48 hours notice to cancel"
];

// Sonnet prompts that are pure policy (vs procedural HOW-TO).
const FOLD_PROMPT_TITLES = [
  "Pause action: 30 or 60 days only",
];

async function main() {
  // ── Macros ────────────────────────────────────────────────────────
  console.log("=== MACROS ===");
  for (const name of STALE_MACRO_NAMES) {
    const { data: rows, error } = await admin
      .from("macros")
      .select("id, name, active")
      .eq("workspace_id", WORKSPACE_ID)
      .eq("name", name);
    if (error) { console.log(`  ✗ lookup failed for "${name}": ${error.message}`); continue; }
    if (!rows?.length) { console.log(`  - not found: ${name}`); continue; }
    for (const m of rows) {
      if (!m.active) { console.log(`  - already inactive: ${m.name}`); continue; }
      const { error: updErr } = await admin
        .from("macros")
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq("id", m.id);
      if (updErr) { console.log(`  ✗ deactivate failed for ${m.name}: ${updErr.message}`); continue; }
      console.log(`  ✓ deactivated: ${m.name}`);
    }
  }

  // ── Sonnet prompts ────────────────────────────────────────────────
  console.log("\n=== SONNET PROMPTS ===");
  for (const title of FOLD_PROMPT_TITLES) {
    const { data: rows, error } = await admin
      .from("sonnet_prompts")
      .select("id, title, enabled")
      .eq("workspace_id", WORKSPACE_ID)
      .eq("title", title);
    if (error) { console.log(`  ✗ lookup failed for "${title}": ${error.message}`); continue; }
    if (!rows?.length) { console.log(`  - not found: ${title}`); continue; }
    for (const p of rows) {
      const newTitle = p.title.startsWith("[FOLDED] ") ? p.title : `[FOLDED] ${p.title}`;
      const { error: updErr } = await admin
        .from("sonnet_prompts")
        .update({ enabled: false, title: newTitle, updated_at: new Date().toISOString() })
        .eq("id", p.id);
      if (updErr) { console.log(`  ✗ fold failed for ${p.title}: ${updErr.message}`); continue; }
      console.log(`  ✓ folded: ${p.title}`);
    }
  }

  // ── Playbook policies ──────────────────────────────────────────────
  // The refund playbook has a "30-Day Return Policy" entry in
  // playbook_policies. Replace its description with a pointer to the
  // canonical policies row so the playbook step rendering surfaces the
  // current policy instead of a stale snapshot.
  console.log("\n=== PLAYBOOK_POLICIES ===");
  const { data: refundPolicy } = await admin
    .from("playbook_policies")
    .select("id, name, description")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("name", "30-Day Return Policy")
    .maybeSingle();
  if (refundPolicy) {
    const { error } = await admin
      .from("playbook_policies")
      .update({
        description: "See canonical Returns Policy (policies table, slug='returns') and Refund Policy (slug='refunds') — they supersede this row. Current Returns Policy: 30-day Money-Back Guarantee applies ONLY to customer's first order. Subscription renewals and additional one-time orders are not eligible. ONE return per customer lifetime.",
        ai_talking_points: "For each order, explain WHY it does or does not qualify. Use the canonical Returns Policy and Refund Policy as the source. Subscription renewals: route to refund playbook (which enforces categorical denial + tier exceptions). First-order MBG case: refund the return without stand-firm cadence.",
      })
      .eq("id", refundPolicy.id);
    if (error) console.log(`  ✗ ${error.message}`); else console.log(`  ✓ updated: 30-Day Return Policy → points at policies table`);
  } else {
    console.log(`  - not found: 30-Day Return Policy`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
