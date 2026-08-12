/**
 * Fire an immediate `internal-subscription/renewal-attempt` for internal subs that were stuck on
 * the `no_payment_method` skip (fixed by _backfill-renewal-default-payment-methods.ts).
 *
 * ⚠️ THIS CHARGES REAL CUSTOMERS. Dry-run by default; --apply to send.
 *
 * Sends NO `expected_next_billing_date` — per the renewal contract that is the immediate-charge
 * path (portal order-now / order-now-by-contract use the same shape) and bypasses the stale-attempt
 * guard, which would otherwise suppress an out-of-band attempt.
 *
 * DELIBERATELY EXCLUDES any sub with an OPEN dunning cycle whose `next_retry_at` is in the future:
 * dunning is the source of truth for when a failed-payment retry is allowed, and forcing a charge
 * here would bypass that schedule and could double-charge against the dunning attempt.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
const SUB_IDS = [
  "2ff698dc-3865-4996-a7a6-5f283ffbc050", // Carol Wisemen  — due 2026-07-19
  "851034c9-983a-4d49-b335-ac365b835bfb", // Veena Singh    — due 2026-07-20
  "7a42e8fd-55f4-44e0-b63f-0fb4afe952d4", // Laurie Predmore— due 2026-07-23
];

async function main() {
  const admin = createAdminClient();

  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, customer_id, status, is_internal, comp, next_billing_date, items")
    .eq("workspace_id", WS).in("id", SUB_IDS);

  const { data: cycles } = await admin
    .from("dunning_cycles")
    .select("subscription_id, status, next_retry_at")
    .eq("workspace_id", WS).in("subscription_id", SUB_IDS);

  const now = new Date();
  const go: string[] = [];

  for (const s of subs ?? []) {
    const problems: string[] = [];
    if (!s.is_internal) problems.push("NOT internal");
    if (s.status !== "active") problems.push(`status=${s.status}`);
    const open = (cycles ?? []).find(
      (c) => String(c.subscription_id) === String(s.id) && ["retrying", "active"].includes(String(c.status)),
    );
    if (open && open.next_retry_at && new Date(String(open.next_retry_at)) > now)
      problems.push(`dunning retry ${String(open.next_retry_at).slice(0, 10)} — dunning owns this`);

    // confirm a default card now resolves (the whole point of the preceding backfill)
    const { linkGroupIds } = await import("../src/lib/customer-links");
    const groupIds = await linkGroupIds(admin, WS, s.customer_id);
    const { data: pm } = await admin
      .from("customer_payment_methods").select("id, card_brand, last4")
      .eq("workspace_id", WS).in("customer_id", groupIds).eq("status", "active").eq("is_default", true).limit(1).maybeSingle();
    if (!pm) problems.push("STILL no default card");

    const items = (s.items as { sku?: string; quantity?: number }[] | null) ?? [];
    console.log(
      `${s.id}\n   due ${String(s.next_billing_date).slice(0, 10)} · ${items.map((i) => `${i.sku} x${i.quantity}`).join(", ")} · ` +
        `card ${pm ? `${pm.card_brand ?? "(no brand)"} *${pm.last4 ?? "????"}` : "NONE"}`,
    );
    if (problems.length) console.log(`   ⛔ SKIP — ${problems.join(" · ")}`);
    else { console.log(`   ✅ will charge`); go.push(s.id); }
  }

  console.log(`\n${go.length} of ${SUB_IDS.length} eligible to charge`);
  if (!APPLY) { console.log("DRY RUN — re-run with --apply to actually charge."); return; }

  const { inngest } = await import("../src/lib/inngest/client");
  for (const id of go) {
    // No expected_next_billing_date — the immediate-charge shape.
    await inngest.send({ name: "internal-subscription/renewal-attempt", data: { subscription_id: id, workspace_id: WS } });
    console.log(`   → dispatched ${id}`);
  }
  console.log(`\n✓ ${go.length} renewal attempt(s) dispatched. Verify with _verify-triggered-renewals.ts.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
