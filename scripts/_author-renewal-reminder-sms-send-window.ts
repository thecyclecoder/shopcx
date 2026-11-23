/**
 * Throwaway author script (CEO 2026-11-23: "never sms anyone before 9am in their local time.
 * Super important or we can get sued"). Idempotent on slug.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
import { getSpec } from "../src/lib/specs-table";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "renewal-reminder-sms-send-window";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    SLUG,
    {
      title: "Renewal reminder SMS: hard 9 AM-8 PM local send window, no guessed timezones, house SMS format",
      why:
        "The CEO's rule before launch: never text anyone before 9 AM their local time, because a quiet-hours breach is a legal (TCPA) risk. " +
        "Today the reminder text can go out early: if the 11 AM local slot has already passed, or the timezone is unknown or invalid, it sends immediately or targets the wrong zone. The text is also a single block, against the house SMS format.",
      what:
        "A reminder text is only ever sent or scheduled for a moment that is between 9:00 AM and 8:00 PM in the recipient's verified local time. If no such moment can be guaranteed, the person gets the email only. The text uses the house block layout.",
      summary:
        "Hardens maybeSendConsentedSms in src/lib/pre-renewal-reminders.ts and adds a reusable quiet-hours guard to src/lib/marketing-text-timezone.ts.",
      owner: "retention",
      parent: '[[../functions/retention]] — "Churn prevention & win-back" mandate: makes the shipped pre-renewal reminder safe to launch.',
      blocked_by: [],
      human_review: "Before launch, confirm a dry run prints each SMS recipient's resolved timezone, source and local send time, all between 9 AM and 8 PM.",
      phases: [
        {
          title: "Phase 1 — Hard local send window for reminder texts",
          why: "A text before 9 AM local is a legal risk the CEO will not accept; the guard must hold for every timezone and every failure path.",
          what: "Every reminder text is checked against the recipient's local clock at the exact moment it will be delivered; anything outside 9 AM to 8 PM, or with an unverified timezone, is not sent and the person gets the email only.",
          body: [
            "Verified gaps in src/lib/pre-renewal-reminders.ts maybeSendConsentedSms (main, 2026-11-23):",
            "1. It computes 11:00 local on the UTC calendar date (`computeSendInstant(toDateKey(now), 11, tz)`), and if that instant is less than 16 minutes away or already past, it sends IMMEDIATELY with no local-time check. With the cron at 13:00 UTC, recipients east of UTC-2 (for example UTC+12/+13) can be texted in the middle of their night.",
            "2. An unresolvable timezone falls back to America/Chicago (DEFAULT_FALLBACK_TZ). A customer actually in Hawaii or Alaska would get the 11 AM Central text at 7-8 AM local.",
            "3. src/lib/marketing-text-timezone.ts getTimezoneOffsetMinutes returns 0 for an unrecognized IANA name, so an invalid customers.timezone string is treated as UTC: 11:00 UTC is already past at 13:00 UTC, so the text goes out immediately (8 AM Eastern).",
            "Build:",
            "a. Add `isWithinSmsSendWindow(instant: Date, timezone: string): boolean` to src/lib/marketing-text-timezone.ts: true only if the timezone is a valid IANA zone (validate with Intl.DateTimeFormat; throw/false on invalid) AND the local wall time at `instant` is >= 09:00 and < 20:00. Export constants SMS_WINDOW_START_HOUR = 9, SMS_WINDOW_END_HOUR = 20.",
            "b. In maybeSendConsentedSms: if tz.source === 'fallback' or the zone is invalid → do not text; stamp sms_status 'suppressed_no_timezone' (ledger) and keep the email. Compute the target as 11:00 local on the recipient's LOCAL calendar date for today; if that is in the past or <16 min away, use 11:00 local TOMORROW (Twilio SendAt allows up to 7 days). Never send without SendAt. Immediately before calling sendSMS, assert `isWithinSmsSendWindow(sendAt, tz.timezone)`; if false, do not send and stamp 'suppressed_quiet_hours'.",
            "c. Same guard for any other SMS path in this flow (none should send unscheduled).",
            "d. SMS body follows the house block layout in .claude/skills/sms-marketing/SKILL.md step 4: a short hook block (what renews and when, plus the amount label from reminderChargePreview), a blank line, a CTA label line ('Review your order:') with the link on its own line in the middle, a blank line, then a short benefit/deadline line ('Make changes before {date}.'). GSM-7 characters only, no em dashes. Not a single word blob.",
            "e. Unit tests in src/lib/pre-renewal-reminders.test.ts: recipients in Pacific/Auckland, Pacific/Honolulu, America/Los_Angeles, America/New_York and an invalid tz string at a 13:00 UTC run — every scheduled send is between 9 AM and 8 PM local, the invalid/fallback cases send no SMS, and nothing is sent without SendAt.",
            "Update docs/brain/libraries/pre-renewal-reminders.md and docs/brain/libraries/marketing-text-timezone.md (create if absent).",
          ].join("\n"),
          verification: ["- tsc clean.", "- isWithinSmsSendWindow present in both files.", "- suppressed_no_timezone present.", "- test:pre-renewal-reminders passes."].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "window guard exists", kind: "auto", exec_kind: "grep", params: { pattern: "isWithinSmsSendWindow", path: "src/lib/marketing-text-timezone.ts", expect: "present" } },
            { position: 3, description: "reminder SMS uses the guard", kind: "auto", exec_kind: "grep", params: { pattern: "isWithinSmsSendWindow", path: "src/lib/pre-renewal-reminders.ts", expect: "present" } },
            { position: 4, description: "unknown timezone gets no text", kind: "auto", exec_kind: "grep", params: { pattern: "suppressed_no_timezone", path: "src/lib/pre-renewal-reminders.ts", expect: "present" } },
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
