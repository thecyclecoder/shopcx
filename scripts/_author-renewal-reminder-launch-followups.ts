/**
 * Throwaway author script (CEO-commissioned 2026-11-22): follow-ups found when re-checking
 * renewal-reminder-launch-readiness (PR #3762). Idempotent on slug.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
import { getSpec } from "../src/lib/specs-table";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company
const SLUG = "renewal-reminder-launch-followups";

const tsc = (p: number) => ({ position: p, description: "tsc clean on the branch", kind: "auto" as const, exec_kind: "tsc" as const, params: null });
const grep = (p: number, description: string, pattern: string, path: string, expect: "present" | "absent" = "present") =>
  ({ position: p, description, kind: "auto" as const, exec_kind: "grep" as const, params: { pattern, path, expect } });
const unit = (p: number, script: string) =>
  ({ position: p, description: `${script} passes`, kind: "auto" as const, exec_kind: "unit_test" as const, params: { script } });

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    SLUG,
    {
      title: "Renewal reminder follow-ups: amount includes tax + shipping, significant verdict, holdout-relative pause floors",
      why:
        "Re-checking renewal-reminder-launch-readiness (PR #3762) on 2026-11-22 found three remaining problems. The reminder amount leaves out sales tax (and shipping on ShopCX-engine subs), so a customer sees one number and is charged a higher one. " +
        "The verdict names a winner at a 1% difference with no significance test, though the test is powered for ~10%. And the cancel/refund hard floors trip on the treatment arm alone, so normal churn could pause the test.",
      what:
        "The reminder shows the total the renewal will actually charge, including tax and shipping (or clearly says 'plus tax' when tax cannot be quoted exactly). The verdict only declares a winner when the difference is statistically significant at the pre-registered alpha. " +
        "Cancel and refund floors trip only when treatment is worse than holdout. Does NOT create or launch the experiment.",
      summary:
        "Touches src/lib/pre-renewal-reminders.ts reminderChargePreview (~line 277-325) and its email/SMS copy (~line 500-520), and src/lib/subscriber-experiment-guardrails.ts HARD_FLOORS (~line 48) + evaluateVerdict (~line 176).",
      owner: "retention",
      parent: '[[../functions/retention]] — "Churn prevention & win-back" mandate: makes the shipped pre-renewal reminder safe to launch.',
      blocked_by: [],
      human_review:
        "Dylan receives a test reminder on his own account and confirms the amount equals what his next renewal will charge, tax and shipping included.",
      phases: [
        {
          title: "Phase 1 — Reminder amount includes tax and shipping",
          why:
            "CEO requirement: the reminder shows exactly what will be charged. reminderChargePreview returns pre-tax merchandise + shipping for internal subs (pricing.product_subtotal_cents + pricing.shipping_cents) and only the sum of stored line prices for other engines, with no tax and no shipping, and the copy does not say so.",
          what:
            "The amount shown is the full charge: merchandise after discounts + shipping + tax, computed the same way the renewal will charge it. When tax cannot be quoted exactly, the reminder shows the pre-tax amount labelled 'plus tax' instead of a bare number.",
          body: [
            "In reminderChargePreview, add `taxCents` and `shippingCents` to the returned ReminderChargePreview and compute `amountCents` as the full charge.",
            "Internal subs: use the renewal path's own tax quote (src/lib/avalara-subscription.ts `quoteSubscriptionTax` / `ensureFreshSubscriptionTaxQuote`, the same inputs the internal renewal worker uses — read src/lib/inngest/internal-subscription-renewals.ts around the Avalara quote). Do not commit tax; quote only.",
            "ShopCX-engine subs: include the contract delivery price and the tax the ShopCX renewal path charges (find how that path computes tax; if it is Shopify-computed at billing and cannot be quoted, set taxCents null).",
            "Add `amountLabel` with value 'total' or 'plus tax'. Copy: when taxCents is null, render the amount as '$X plus tax'; never a bare pre-tax number. Same for the SMS. Stamp the amount actually shown on previewed_amount_cents and add `previewed_includes_tax boolean` (migration) so the audit can compare to the real charge.",
            "Shipping Protection lines are not products; keep excluding them from the item list, but include their charge in the total if the renewal bills them.",
            "Update docs/brain/libraries/pre-renewal-reminders.md and docs/brain/tables/pre_renewal_reminders.md.",
          ].join("\n"),
          verification: ["- tsc clean.", "- `taxCents` and `plus tax` present in pre-renewal-reminders.ts.", "- test:pre-renewal-reminders passes."].join("\n"),
          status: "planned",
          checks: [
            tsc(1),
            grep(2, "preview carries tax", "taxCents", "src/lib/pre-renewal-reminders.ts"),
            grep(3, "copy labels un-quoted tax", "plus tax", "src/lib/pre-renewal-reminders.ts"),
            grep(4, "ledger records whether tax was included", "previewed_includes_tax", "src/lib/pre-renewal-reminders.ts"),
            unit(5, "test:pre-renewal-reminders"),
          ],
        },
        {
          title: "Phase 2 — Significant verdict and holdout-relative pause floors",
          why:
            "evaluateVerdict (src/lib/subscriber-experiment-guardrails.ts) declares treatment_wins/holdout_wins at a 1% relative difference with no significance test, while the experiment's required_n_per_arm is powered for its target MDE (~10%). HARD_FLOORS.voluntaryCancelRate / refundRate (0.2) trip on the treatment arm's own rate regardless of holdout, so normal 90-day churn could pause the test.",
          what:
            "The verdict is 'no_difference' unless a two-sample test on per-person 90-day net merchandise revenue rejects at the experiment's pre-registered alpha; it reports the lift with a confidence interval. Cancel and refund floors trip only on treatment's EXCESS over holdout. The SMS STOP floor stays absolute.",
          body: [
            "evaluateVerdict needs per-person revenue (or per-arm mean + variance). Extend computeExperimentMetrics / ArmResults to expose the per-arm variance of per-person net merchandise revenue (src/lib/subscriber-experiment-metrics.ts). Use Welch's t-test (or a bootstrap) at experiment.alpha; add `confidenceInterval` { lowCents, highCents } to the verdict detail. Verdict = treatment_wins / holdout_wins only when the interval excludes 0.",
            "Replace the absolute voluntaryCancelRate and refundRate floors with `voluntaryCancelExcessOverHoldout` and `refundExcessOverHoldout` (treatment rate minus holdout rate, e.g. 0.05 = 5 points), applied only once each arm has at least netRevenueMinN groups. Keep smsOptOutRate absolute.",
            "Update the dashboard verdict banner to show the interval, and docs/brain/libraries/subscriber-experiment-guardrails.md + docs/brain/inngest/subscriber-experiment-guardrails.md.",
          ].join("\n"),
          verification: ["- tsc clean.", "- `confidenceInterval` and `voluntaryCancelExcessOverHoldout` present.", "- test:subscriber-experiments + test:reminder-results-sdk pass."].join("\n"),
          status: "planned",
          checks: [
            tsc(1),
            grep(2, "verdict reports an interval", "confidenceInterval", "src/lib/subscriber-experiment-guardrails.ts"),
            grep(3, "cancel floor is relative to holdout", "voluntaryCancelExcessOverHoldout", "src/lib/subscriber-experiment-guardrails.ts"),
            grep(4, "refund floor is relative to holdout", "refundExcessOverHoldout", "src/lib/subscriber-experiment-guardrails.ts"),
            unit(5, "test:subscriber-experiments"),
            unit(6, "test:reminder-results-sdk"),
          ],
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "retention#churn-prevention-win-back" },
  );
  console.log(ok ? "authored" : "author write failed");
  const s = await getSpec(WORKSPACE_ID, SLUG);
  console.log(JSON.stringify({ slug: s?.slug, status: (s as { status?: string } | null)?.status, phases: (s as { phases?: unknown[] } | null)?.phases?.length }, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
