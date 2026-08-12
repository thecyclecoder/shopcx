/**
 * Ship-time backfill: flag a default payment method for internal subs that have a WORKING
 * Braintree token but no `is_default = true` card.
 *
 * The renewal attempt resolves a card via `sub.payment_method_id`, else a link-group card that is
 * `status='active'` AND `is_default=true`. With neither it returns `no_payment_method` — and that
 * path deliberately does NOT advance `next_billing_date`, so the sub re-attempts and skips again
 * every day, forever. Audited 2026-08-12: 6 of 109 active paid internal subs, 3 of them silently
 * stuck since 2026-07-19..23. Every one had a tokenised card on file.
 *
 * Picks the newest `status='active'` card that HAS a braintree token, preferring one with a
 * `card_brand`/`last4` on file (degenerate null-brand rows exist). Because the default spans the
 * customer LINK GROUP ("one default per person"), any other default in that group is cleared
 * first so exactly one survives.
 *
 * DRY RUN by default. Pass --apply to write.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { linkGroupIds } from "../src/lib/customer-links";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

interface Pm {
  id: string; customer_id: string; status: string | null; is_default: boolean | null;
  card_brand: string | null; last4: string | null; braintree_payment_method_token: string | null;
  created_at: string;
}

async function main() {
  const admin = createAdminClient();

  const { data: subs, error } = await admin
    .from("subscriptions")
    .select("id, customer_id, next_billing_date, comp")
    .eq("workspace_id", WS).eq("is_internal", true).eq("status", "active");
  if (error) throw new Error(error.message);

  const fixes: { subId: string; customerId: string; pm: Pm; groupIds: string[]; clearing: string[] }[] = [];

  for (const s of subs ?? []) {
    if (s.comp) continue; // comp renews without a card by design
    const groupIds = await linkGroupIds(admin, WS, s.customer_id);
    const { data: pmsRaw } = await admin
      .from("customer_payment_methods")
      .select("id, customer_id, status, is_default, card_brand, last4, braintree_payment_method_token, created_at")
      .eq("workspace_id", WS).in("customer_id", groupIds);
    const pms = (pmsRaw ?? []) as Pm[];

    if (pms.some((p) => p.status === "active" && p.is_default)) continue; // already resolvable
    const usable = pms.filter((p) => p.status === "active" && p.braintree_payment_method_token);
    if (!usable.length) continue; // genuinely no card — a different problem, not this backfill's

    // prefer a card that actually identifies itself, then newest
    usable.sort((a, b) => {
      const ai = a.card_brand && a.last4 ? 1 : 0, bi = b.card_brand && b.last4 ? 1 : 0;
      if (ai !== bi) return bi - ai;
      return b.created_at.localeCompare(a.created_at);
    });
    const pick = usable[0];
    const clearing = pms.filter((p) => p.is_default && p.id !== pick.id).map((p) => p.id);
    fixes.push({ subId: s.id, customerId: s.customer_id, pm: pick, groupIds, clearing });
  }

  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${fixes.length} subscription(s) need a default card\n`);
  for (const f of fixes) {
    console.log(
      `sub ${f.subId}\n   → set default: ${f.pm.card_brand ?? "(no brand)"} *${f.pm.last4 ?? "????"} ` +
        `(pm ${f.pm.id}, token ${f.pm.braintree_payment_method_token ? "✓" : "✗"})` +
        (f.clearing.length ? `   clearing ${f.clearing.length} other default(s)` : ""),
    );
  }
  if (!APPLY) {
    console.log(`\nRe-run with --apply to write.`);
    return;
  }

  let applied = 0;
  for (const f of fixes) {
    if (f.clearing.length) {
      const { error: e1 } = await admin.from("customer_payment_methods").update({ is_default: false }).in("id", f.clearing);
      if (e1) throw new Error(`clear defaults: ${e1.message}`);
    }
    const { error: e2 } = await admin.from("customer_payment_methods").update({ is_default: true }).eq("id", f.pm.id);
    if (e2) throw new Error(`set default: ${e2.message}`);
    applied++;
  }
  console.log(`\n✓ ${applied} default(s) set`);

  // verify by re-running the same resolution the renewal path uses
  let stillBroken = 0;
  for (const f of fixes) {
    const { data: check } = await admin
      .from("customer_payment_methods").select("id")
      .eq("workspace_id", WS).in("customer_id", f.groupIds).eq("status", "active").eq("is_default", true).limit(1);
    if (!check?.length) { stillBroken++; console.log(`   ⚠ ${f.subId} STILL unresolvable`); }
  }
  console.log(stillBroken ? `⚠ ${stillBroken} still unresolvable` : `✓ all ${applied} now resolve a default card`);
}
main().catch((e) => { console.error(e); process.exit(1); });
