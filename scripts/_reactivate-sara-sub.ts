/**
 * One-off: CEO-directed reactivation of Sara Kasemeier's subscription
 * (contract 27804762285) — ticket 789cd8ed-d999-4970-ad69-ea7d967dbe4d.
 * Cancelled 2026-07-21 21:07; next billing should stay 2026-09-30 so it
 * ships in September. Commerce SDK only — no raw Appstle calls.
 */
import "./_bootstrap";
import {
  subscriptionAction,
  subscriptionUpdateNextBillingDate,
  getSubscriptionByContractId,
  subscriptionGetLiveContract,
} from "../src/lib/commerce/subscription";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const CONTRACT = "27804762285";
const TARGET_NEXT_BILLING = "2026-09-30";

async function main() {
  const before = await getSubscriptionByContractId(WS, CONTRACT);
  console.log("BEFORE:", JSON.stringify({ status: before?.status, next: before?.next_billing_date }));

  const resumed = await subscriptionAction(WS, CONTRACT, "resume");
  console.log("resume →", JSON.stringify(resumed));
  if (!resumed.success) process.exit(1);

  const afterResume = await getSubscriptionByContractId(WS, CONTRACT);
  console.log("AFTER RESUME:", JSON.stringify({ status: afterResume?.status, next: afterResume?.next_billing_date }));

  // Re-assert the September date — a resume can snap next-billing to "now + interval".
  const nextIso = String(afterResume?.next_billing_date ?? "");
  if (!nextIso.startsWith("2026-09")) {
    console.log(`next billing is ${nextIso || "(none)"} — re-setting to ${TARGET_NEXT_BILLING}`);
    const dated = await subscriptionUpdateNextBillingDate(WS, CONTRACT, TARGET_NEXT_BILLING);
    console.log("updateNextBillingDate →", JSON.stringify(dated));
    if (!dated.success) process.exit(1);
  } else {
    console.log("next billing already in September — no date change needed");
  }

  const live = await subscriptionGetLiveContract(WS, CONTRACT);
  console.log("LIVE CONTRACT:", JSON.stringify(live, null, 2).slice(0, 1500));

  const final = await getSubscriptionByContractId(WS, CONTRACT);
  console.log("FINAL (mirror):", JSON.stringify({ status: final?.status, next: final?.next_billing_date }));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
