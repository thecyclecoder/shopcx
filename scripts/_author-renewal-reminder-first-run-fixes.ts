/**
 * Throwaway author script: fixes found on the first live run of the pre-renewal reminder test (2026-11-24). Idempotent on slug.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
import { getSpec } from "../src/lib/specs-table";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "renewal-reminder-first-run-fixes";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    SLUG,
    {
      title: "Renewal reminder first-run fixes: true STOP opt-out guardrail, no last-item remove, failed date change",
      why:
        "On the first live run (2026-11-24) the guardrail paused the test on a false alarm: it counted 15 customers who had unsubscribed from texts BEFORE the run as reminder opt-outs (21.1%), though 0 of the 34 texted replied STOP. " +
        "Separately, 6 customers tried to remove the only item on their subscription in the next-order journey, which can never succeed, and one date change failed for an unknown reason. Each became a manual ticket.",
      what:
        "The opt-out guardrail counts only customers who replied STOP after a reminder text. The journey never offers remove on a single-item subscription and steers to skip or cancel instead, matching the Portal. The failed date change is diagnosed and fixed or turned into a clear customer message. The test is NOT resumed by this spec; resuming stays a CEO action.",
      summary:
        "Touches src/lib/subscriber-experiment-guardrails.ts (smsOptOut signal), src/lib/retention/reminder-results-sdk.ts (engagement counts), src/lib/pre-renewal-reminders.ts ledger reads, src/lib/next-order-journey-builder.ts + src/app/journey/[token]/page.tsx editor, and src/app/api/journey/[token]/edit/route.ts.",
      owner: "retention",
      parent: '[[../functions/retention]] — "Churn prevention & win-back" mandate: keeps the live pre-renewal reminder test running safely.',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Opt-out guardrail counts only STOP replies to reminder texts",
          why: "A guardrail that trips on pre-existing unsubscribes pauses the test on every run, since ~20% of the audience was already unsubscribed.",
          what: "The SMS opt-out rate = treatment customers who were texted a reminder and then opted out (STOP / sms_marketing_status flipped to unsubscribed after sms_scheduled_send_at) divided by treatment customers texted. Ledger rows with sms_status 'suppressed_stop' (already unsubscribed before the run) are excluded from both numerator and denominator.",
          body: [
            "In src/lib/subscriber-experiment-guardrails.ts evaluateGuardrails, the SMS opt-out signal currently uses `smsSuppressedStop` from the reminder ledger (status 'suppressed_stop' = already unsubscribed at send time). Replace it with `smsOptOutsAfterReminder`: count treatment ledger rows with sms_status in ('scheduled','sent') whose customer opted out after sms_scheduled_send_at (read the Twilio inbound STOP / marketing-consent change record — probe the real table, e.g. sms consent events or customers.sms_marketing_status + its updated timestamp). Denominator = treatment rows actually texted. Holdout has no texts, so compare against the absolute floor only.",
            "Expose the same count in src/lib/retention/reminder-results-sdk.ts and relabel the dashboard metric 'STOP replies to reminder texts'. Keep 'already unsubscribed' as a separate, informational count.",
            "Add a unit test: 15 suppressed_stop + 34 texted with 0 later STOPs must NOT trip.",
            "Update docs/brain/libraries/subscriber-experiment-guardrails.md.",
          ].join("\n"),
          verification: ["- tsc clean.", "- smsOptOutsAfterReminder present.", "- test:subscriber-experiments passes."].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "guardrail uses post-reminder opt-outs", kind: "auto", exec_kind: "grep", params: { pattern: "smsOptOutsAfterReminder", path: "src/lib/subscriber-experiment-guardrails.ts", expect: "present" } },
            { position: 3, description: "test:subscriber-experiments passes", kind: "auto", exec_kind: "unit_test", params: { script: "test:subscriber-experiments" } },
            { position: 4, description: "test:reminder-results-sdk passes", kind: "auto", exec_kind: "unit_test", params: { script: "test:reminder-results-sdk" } },
          ],
        },
        {
          title: "Phase 2 — No last-item remove in the journey; diagnose the failed date change",
          why: "Removing the only product on a subscription always fails, so customers who wanted to skip or cancel got an error and a manual ticket. The Portal already blocks last-item removal; the journey must match.",
          what: "On a subscription with one product line (Shipping Protection lines don't count), the journey hides Remove and shows 'Skip this order' and 'Cancel subscription' in its place; the edit route also refuses a last-item remove with a customer-safe message pointing to skip/cancel (no ticket). The failed date change is root-caused.",
          body: [
            "Add `isLastProductLine(sub, variantId)` (exclude Shipping Protection lines) and use it in src/lib/next-order-journey-builder.ts (mark items non-removable) and src/app/journey/[token]/page.tsx (render skip/cancel instead of remove). In src/app/api/journey/[token]/edit/route.ts, reject a last-item remove as a validationError ('last_item') before dispatch, so it never reaches raiseFailedEdit. Mirror the Portal's last-item guard (src/lib/portal/handlers/remove-line-item.ts).",
            "Date change: on 2026-11-24 one ShopCX-billed sub's change_date edit failed with no stored reason. Make raiseFailedEdit persist the executor error string in the notification metadata, then reproduce the failure path in subscriptionUpdateNextBillingDate for ShopCX-engine subs (candidates: date outside allowed range, cycle-edit lock, same-day as billing) and either fix it or map it to a clear validation message. Describe the cause in the PR body.",
            "Unit test: a single-item sub yields no removable items and the route returns validationError 'last_item'.",
            "Update docs/brain/journeys/next-order.md.",
          ].join("\n"),
          verification: ["- tsc clean.", "- isLastProductLine present in builder and edit route.", "- test:editable-catalog passes."].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "builder marks the last item non-removable", kind: "auto", exec_kind: "grep", params: { pattern: "isLastProductLine", path: "src/lib/next-order-journey-builder.ts", expect: "present" } },
            { position: 3, description: "edit route refuses last-item remove", kind: "auto", exec_kind: "grep", params: { pattern: "last_item", path: "src/app/api/journey/[token]/edit/route.ts", expect: "present" } },
            { position: 4, description: "test:editable-catalog passes", kind: "auto", exec_kind: "unit_test", params: { script: "test:editable-catalog" } },
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
