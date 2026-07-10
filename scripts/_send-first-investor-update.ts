import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { buildInvestorPerformance, renderInvestorEmailHtml, renderInvestorSms } from "../src/lib/investor-update";
import { generateInvestorMagicLink } from "../src/lib/investors/auth";
import { sendInvestorUpdateEmail } from "../src/lib/email";
import { sendSMS } from "../src/lib/twilio";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const DYLAN_ID = "231a426a-b821-4f3d-9798-e52fabee639d";
const DYLAN_EMAIL = "dylan@superfoodscompany.com";
const DYLAN_PHONE = "+18583349198";

// Hand-curated for the FIRST send — the real, recent, non-technical initiatives
// (from recent merged work + the brain). Overrides the default INVESTOR_BUILDING.
const BUILDING = [
  "We've built AI that produces our ad creative end to end — the product photography, the before/after imagery, and the offer itself — so we can test far more angles and keep bringing the cost of each new customer down.",
  "Customer support now runs on AI that resolves the everyday questions instantly and only pulls in a person for the judgment calls (like refunds), which keeps subscribers happy and subscribed without adding headcount.",
  "We connected our real accounting books straight into this live dashboard — the very charts in this email — so every number is the actual number, and we're extending it into a full company scoreboard.",
];

async function main() {
  const dry = process.argv.includes("--dry");
  const admin = createAdminClient();

  const { data: ws } = await admin.from("workspaces").select("sandbox_mode, resend_domain").eq("id", WS).single();
  console.log("sandbox_mode:", ws?.sandbox_mode, "| resend_domain:", ws?.resend_domain);
  if (ws?.sandbox_mode) console.log("⚠ sandbox_mode ON — non-member sends will be blocked.");

  const perf = await buildInvestorPerformance(WS, admin);
  if (!perf) { console.log("No performance data — aborting."); return; }
  perf.building = BUILDING;

  const link = generateInvestorMagicLink(DYLAN_ID, DYLAN_EMAIL, WS);
  console.log("\nMagic link:", link);
  console.log("\nPerformance summary:");
  console.log("  period:", perf.periodLabel, "|", perf.primaryLabel);
  console.log("  primary revenue:", perf.primaryRevenue, "YoY:", perf.primaryYoYPct, "vs", perf.comparisonLabel);
  console.log("  focal lines:", perf.focal.length, "| working:", perf.working.length, "| needsHelp:", perf.needsHelp.length);
  perf.focal.forEach((f) => console.log("   ·", f.label, f.sentence));
  const sms = renderInvestorSms(perf, link);
  console.log("\nSMS body:\n ", sms, `(${sms.length} chars)`);

  if (dry) { console.log("\n--dry: not sending."); return; }

  const emailRes = await sendInvestorUpdateEmail({
    workspaceId: WS,
    toEmail: DYLAN_EMAIL,
    subject: `Superfoods investor update — ${perf.latestMonthLabel}`,
    html: renderInvestorEmailHtml({ firstName: "Dylan", link, perf }),
  });
  console.log("\nEMAIL:", emailRes.error ? `ERROR ${emailRes.error}` : `sent (id ${emailRes.messageId})`);

  const smsRes = await sendSMS(WS, DYLAN_PHONE, sms);
  console.log("SMS:", smsRes.success ? `sent (sid ${smsRes.messageSid})` : `ERROR ${smsRes.error ?? smsRes.errorCode}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
