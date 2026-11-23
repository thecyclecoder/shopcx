/**
 * Throwaway author script (CEO 2026-11-23: "ShopCX subs have a total"). Idempotent on slug.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
import { getSpec } from "../src/lib/specs-table";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "renewal-reminder-amount-all-engines";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    SLUG,
    {
      title: "Renewal reminder amount: one money resolver for every engine, comped subs say free",
      why:
        "CEO 2026-11-23: ShopCX subscriptions have a total, yet the reminder shows none for them. reminderChargePreview (src/lib/pre-renewal-reminders.ts) hand-sums `items[].price`, but ShopCX/Appstle-shape lines carry `price_cents` (see src/lib/commerce/shopcx-line-ops.ts:203), so every ShopCX-engine sub (most of MRR) resolves to no amount. " +
        "It also bypasses src/lib/commerce/price.ts `priceSubscription`, which its own header calls 'the ONE money resolver' for every display surface (portal, mini-site, dashboard). A comped sub shows a bare '$0.00'.",
      what:
        "The reminder (email + SMS) and the next-order journey total use `priceSubscription(...).pricing.total_cents` for every engine, so the number matches what the Portal shows. Comped subs (sub.comp) say the order is free / on us instead of '$0.00'. Tax handling from renewal-reminder-launch-followups is layered on top of this total, not re-derived.",
      summary:
        "Replace the per-engine branches in reminderChargePreview with priceSubscription from src/lib/commerce/price.ts; apply the same to src/lib/next-order-journey-builder.ts totals for non-internal subs.",
      owner: "retention",
      parent: '[[../functions/retention]] — "Churn prevention & win-back" mandate: makes the shipped pre-renewal reminder safe to launch.',
      blocked_by: ["renewal-reminder-launch-followups"],
      human_review: "Dylan's test reminder for his Dec 8 ShopCX-engine Creatine sub shows the same total the Portal shows for it.",
      phases: [
        {
          title: "Phase 1 — Use priceSubscription for the reminder and journey totals",
          why: "One money resolver keeps the reminder, journey and Portal showing the same number, and fixes ShopCX subs showing no amount.",
          what: "reminderChargePreview and the next-order journey total call priceSubscription for all engines; comped subs render as free.",
          body: [
            "In src/lib/pre-renewal-reminders.ts reminderChargePreview: select the full subscription row priceSubscription needs, call `priceSubscription(workspaceId, sub)`, and use pricing.total_cents (merchandise after discounts + shipping + protection as the renewal bills it). Remove the hand-summed `items[].price` branch. On PriceInvariantError return amountCents null (omit rather than guess).",
            "Keep the tax layer the follow-up spec adds (taxCents / 'plus tax' label) on top of total_cents; if that spec already landed, rebase onto it rather than duplicating tax logic.",
            "Comped subs (`sub.comp` true, or total 0 with every product line at $0): render 'This order is on us' (no '$0.00') in email and SMS.",
            "In src/lib/next-order-journey-builder.ts, non-internal subs' total must also come from priceSubscription (same shape the Portal uses via src/lib/portal/helpers/enrich-pricing.ts).",
            "Add a unit test to src/lib/pre-renewal-reminders.test.ts: a ShopCX-shape sub with `price_cents` lines yields a non-null amount; a comped sub yields the free wording. Update docs/brain/libraries/pre-renewal-reminders.md.",
          ].join("\n"),
          verification: ["- tsc clean.", "- `priceSubscription` used in pre-renewal-reminders.ts.", "- test:pre-renewal-reminders passes."].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "reminder uses the one money resolver", kind: "auto", exec_kind: "grep", params: { pattern: "priceSubscription", path: "src/lib/pre-renewal-reminders.ts", expect: "present" } },
            { position: 3, description: "comped wording present", kind: "auto", exec_kind: "grep", params: { pattern: "on us", path: "src/lib/pre-renewal-reminders.ts", expect: "present" } },
            { position: 4, description: "journey total uses the resolver", kind: "auto", exec_kind: "grep", params: { pattern: "priceSubscription", path: "src/lib/next-order-journey-builder.ts", expect: "present" } },
            { position: 5, description: "test:pre-renewal-reminders passes", kind: "auto", exec_kind: "unit_test", params: { script: "test:pre-renewal-reminders" } },
          ],
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "retention#churn-prevention-win-back" },
  );
  console.log(ok ? "authored" : "author write failed");
  const s = await getSpec(WORKSPACE_ID, SLUG);
  console.log(JSON.stringify({ slug: s?.slug, status: (s as { status?: string } | null)?.status }, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
