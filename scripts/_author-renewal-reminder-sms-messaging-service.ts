/**
 * Throwaway author script (CEO 2026-11-23 9 AM rule). Idempotent on slug.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
import { getSpec } from "../src/lib/specs-table";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "renewal-reminder-sms-messaging-service";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    SLUG,
    {
      title: "Scheduled texts must go through the marketing Messaging Service, never a bare From number",
      why:
        "The CEO's legal rule is that no text goes out before 9 AM local. The reminder now computes a safe send time, but it hands it to sendSMS without a Messaging Service. " +
        "Twilio only schedules messages sent through a Messaging Service, so a scheduled text sent from a bare phone number either fails or goes out immediately, which at the 13:00 UTC run is 7-8 AM in the US.",
      what:
        "The reminder text is sent through the workspace's marketing Messaging Service so Twilio holds it until the scheduled time. If no Messaging Service is configured, no text is sent (email only). sendSMS refuses any scheduled send that lacks a Messaging Service, for every caller.",
      summary:
        "src/lib/pre-renewal-reminders.ts maybeSendConsentedSms calls sendSMS(..., { sendAt }) with no messagingServiceSid; src/lib/twilio.ts only uses SendAt correctly with MessagingServiceSid. marketing-text.ts already passes workspaces.twilio_marketing_messaging_service_sid.",
      owner: "retention",
      parent: '[[../functions/retention]] — "Churn prevention & win-back" mandate: makes the shipped pre-renewal reminder safe to launch.',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Messaging Service for scheduled reminder texts + sendSMS hard refusal",
          why: "A computed send time only protects the customer if Twilio actually holds the message until then.",
          what: "Reminder texts carry the marketing Messaging Service SID; sendSMS rejects SendAt without one.",
          body: [
            "1. src/lib/twilio.ts sendSMS: if options.sendAt is set and options.messagingServiceSid is empty, return { success: false, error: 'scheduled_send_requires_messaging_service' } WITHOUT calling Twilio. Never fall back to an immediate send. Add a unit test (new package.json script `test:twilio-scheduled-send-guard`).",
            "2. src/lib/pre-renewal-reminders.ts: read workspaces.twilio_marketing_messaging_service_sid (same column marketing-text.ts uses, src/lib/inngest/marketing-text.ts ~line 457) in runPreRenewalRemindersForWorkspace, pass it to maybeSendConsentedSms and on to sendSMS as messagingServiceSid. If it is null, stamp sms_status 'suppressed_no_messaging_service' and send no text (email still goes).",
            "3. Grep every other sendSMS caller that passes sendAt and confirm each passes messagingServiceSid; list them in the PR body.",
            "4. Update docs/brain/libraries/pre-renewal-reminders.md and the twilio integration page (docs/brain/integrations/twilio.md).",
          ].join("\n"),
          verification: ["- tsc clean.", "- guard string present in twilio.ts.", "- messagingServiceSid passed in pre-renewal-reminders.ts.", "- test:pre-renewal-reminders passes."].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "sendSMS refuses SendAt without a Messaging Service", kind: "auto", exec_kind: "grep", params: { pattern: "scheduled_send_requires_messaging_service", path: "src/lib/twilio.ts", expect: "present" } },
            { position: 3, description: "reminder passes the Messaging Service", kind: "auto", exec_kind: "grep", params: { pattern: "messagingServiceSid", path: "src/lib/pre-renewal-reminders.ts", expect: "present" } },
            { position: 4, description: "no-service path suppresses the text", kind: "auto", exec_kind: "grep", params: { pattern: "suppressed_no_messaging_service", path: "src/lib/pre-renewal-reminders.ts", expect: "present" } },
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
