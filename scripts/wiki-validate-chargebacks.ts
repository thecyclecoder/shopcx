/**
 * Wiki-validation suite — see wiki-validate-dunning.ts for the
 * convention. Each script answers a real query using only the wiki.
 *
 * This one: "for recent chargebacks, find which subscription(s) were
 * cancelled as a result."
 *
 * Join path:
 *   chargeback_events.id
 *     → chargeback_subscription_actions.chargeback_event_id
 *     → chargeback_subscription_actions.subscription_id (UUID)
 *     → subscriptions.id
 *
 * Tables exercised:
 *   - [[tables/chargeback_events]]
 *   - [[tables/chargeback_subscription_actions]]
 *   - [[tables/subscriptions]]
 *   - [[tables/customers]]
 *
 * Gotchas the wiki was patched to surface after this test:
 *   - chargeback_subscription_actions.executed_at — there is NO
 *     created_at column. The existing example used .order('created_at')
 *     and would throw.
 *   - Only `fraudulent` chargebacks trigger subscriptions_cancelled
 *     auto-action; product_not_received etc. get flagged_for_review.
 *   - auto_action_taken='subscriptions_cancelled' tells you the action
 *     fired; join the child table to see WHICH subs.
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const { data: chargebacks } = await sb.from("chargeback_events")
    .select("id, shopify_dispute_id, customer_id, dispute_type, reason, amount_cents, status, auto_action_taken, auto_action_at, initiated_at, finalized_on")
    .eq("workspace_id", WS)
    .order("initiated_at", { ascending: false })
    .limit(20);
  if (!chargebacks?.length) { console.log("No chargebacks."); return; }
  console.log(`Last ${chargebacks.length} chargebacks in workspace:\n`);

  for (const cb of chargebacks) {
    const { data: actions } = await sb.from("chargeback_subscription_actions")
      .select("subscription_id, action, cancellation_reason, executed_at, executed_by")
      .eq("chargeback_event_id", cb.id)
      .order("executed_at", { ascending: false });

    // Pull cancelled subs via UUID, and customer name for context
    const subIds = (actions || []).map(a => a.subscription_id).filter(Boolean) as string[];
    const [{ data: subs }, { data: cust }] = await Promise.all([
      subIds.length
        ? sb.from("subscriptions").select("id, status, items, next_billing_date").in("id", subIds)
        : Promise.resolve({ data: [] }),
      cb.customer_id
        ? sb.from("customers").select("email, first_name, last_name").eq("id", cb.customer_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const subById = new Map((subs || []).map(s => [s.id as string, s]));

    const custStr = cust ? `${cust.first_name || ""} ${cust.last_name || ""} <${cust.email}>`.trim() : "(no customer)";
    const amt = typeof cb.amount_cents === "number" ? `$${(cb.amount_cents / 100).toFixed(2)}` : "—";
    console.log(`--- ${cb.initiated_at?.slice(0, 10)} | ${cb.shopify_dispute_id} | ${amt} ---`);
    console.log(`  customer:        ${custStr}`);
    console.log(`  reason:          ${cb.reason || "—"} (${cb.dispute_type}) · status=${cb.status}`);
    console.log(`  auto action:     ${cb.auto_action_taken || "—"}${cb.auto_action_at ? ` @ ${cb.auto_action_at.slice(0, 16)}` : ""}`);
    if (!actions?.length) {
      console.log(`  sub actions:     (none)`);
    } else {
      for (const a of actions) {
        const sub = a.subscription_id ? subById.get(a.subscription_id) : null;
        const items = (sub?.items as Array<{ title?: string; variant_title?: string; quantity?: number }> | undefined) || [];
        const itemStr = items.map(i => `${i.quantity}× ${i.title}${i.variant_title ? ` [${i.variant_title}]` : ""}`).join(", ") || "(no items)";
        console.log(`  sub action:      ${a.action} (${a.cancellation_reason || "no reason"}) @ ${a.executed_at?.slice(0, 16)} by ${a.executed_by}`);
        console.log(`    sub now:       ${sub?.status || "?"} | ${itemStr}`);
      }
    }
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
