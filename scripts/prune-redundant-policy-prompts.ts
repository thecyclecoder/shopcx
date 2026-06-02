/**
 * Removes sonnet_prompts entries that are now redundant with the policies
 * table. These are PURE POLICY statements that have been folded into the
 * structured policy documents. PROCEDURAL prompts (how to fire a tool,
 * how to format a response, routing decisions) are kept — they're not
 * policy and the policies table doesn't replace them.
 *
 * Soft-delete strategy: we set enabled=false and rename the title with a
 * "[FOLDED] " prefix, so the row remains for audit but is invisible to the
 * orchestrator pre-context (which already filters by enabled=true).
 *
 * The full original content of each removed prompt is preserved in
 * /tmp/refund-prompts-full.txt (from the audit dump) so we can restore
 * if something breaks.
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

// Pure-policy prompts whose content is now in the policies table. Procedural
// prompts (tool placeholders, multi-question handling, routing-only) are
// intentionally kept — they aren't policy.
const REDUNDANT_PROMPT_IDS: { id: string; title: string; reason: string }[] = [
  { id: "fe9bddbe-e673-4e66-aea7-5c713be0799f", title: "One return per subscription — never authorize a second", reason: "Policy changed to one-per-customer-lifetime; in returns policy" },
  { id: "cd904f0e-962d-491c-b343-fee344f0f402", title: "Returns require fulfilled orders — don't try on just-processed renewals", reason: "Captured in returns policy" },
  { id: "335d7ec6-b13b-4472-9cb8-9732db73757e", title: "Price complaints", reason: "Stripped thresholds; captured in refunds policy" },
  { id: "aa1a6bf5-e7fe-4dca-9128-c37d96d01ba5", title: "Returns and refunds always go through the playbook (or crisis flow)", reason: "Captured in returns + refunds policies" },
  { id: "d6e244f0-c9d6-4c77-b760-708ca62f5095", title: "Price-discrepancy direct refund (skip playbook)", reason: "Captured in refunds policy" },
  { id: "d56fe61c-5ba1-495c-9d43-529ec9808fb9", title: "Check for grandfathered pricing when customer reports overcharge", reason: "Captured in refunds policy" },
  { id: "8afaabea-5862-4bf0-bf41-c515cd557743", title: "Per-unit price comparison", reason: "Captured in refunds policy (grandfathered pricing)" },
  { id: "1e691b5e-0fee-43ea-a766-e9f1a5698410", title: "Crisis swap — don't apologize, don't pre-empt Tier 2 coupon", reason: "Captured in crisis policy" },
];

async function main() {
  for (const p of REDUNDANT_PROMPT_IDS) {
    const { data: existing } = await admin
      .from("sonnet_prompts")
      .select("id, title, enabled")
      .eq("id", p.id)
      .maybeSingle();
    if (!existing) {
      console.log(`✗ not found: ${p.id} — ${p.title}`);
      continue;
    }
    const newTitle = existing.title.startsWith("[FOLDED] ")
      ? existing.title
      : `[FOLDED] ${existing.title}`;
    const { error } = await admin
      .from("sonnet_prompts")
      .update({
        enabled: false,
        title: newTitle,
        updated_at: new Date().toISOString(),
      })
      .eq("id", p.id);
    if (error) {
      console.log(`✗ failed: ${p.id} — ${error.message}`);
      continue;
    }
    console.log(`✓ folded: ${p.title}`);
    console.log(`         → ${p.reason}`);
  }

  // Report
  const { data: remaining } = await admin
    .from("sonnet_prompts")
    .select("id", { count: "exact", head: false })
    .eq("enabled", true);
  console.log(`\nRemaining enabled prompts: ${(remaining || []).length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
