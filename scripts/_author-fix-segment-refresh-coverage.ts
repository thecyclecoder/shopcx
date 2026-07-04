import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
import { getSpec } from "../src/lib/specs-table";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "fix-segment-refresh-coverage",
    {
      title: "Fix daily segment refresh — whole-book coverage + staleness alarm",
      why: "The daily customers.segments refresh silently stopped covering the book: as of 2026-07-04 only ~1,000 of 138K SMS-subscribed customers were refreshed in the last 24h, ~46,859 hadn't been touched since 2026-05-16, and 1,943 were never refreshed. Marketing SMS targets stale segments — the exact failure that sent SUMMERFIT (2026-05-31) on a 2026-05-16 snapshot. Revenue-affecting and invisible until manually probed.",
      what: "Make the daily cron refresh EVERY SMS-subscribed customer each run, and add a coverage guardrail so a regression trips an alarm within a day instead of being discovered ~20 days later by hand.",
      summary: "Root cause: src/lib/inngest/refresh-customer-segments.ts:107 fetches a keyset page with .limit(STEP_BATCH) where STEP_BATCH=2000 (line 45), but the Supabase/PostgREST client silently caps a select at 1000 rows. So line 198's `nextCursor = batch.length < limit ? null : ...` sees 1000 < 2000 → returns null → the cursor loop (lines 218-227) breaks after ONE page. The cron refreshes only the lowest-id ~1000 customers/day and never advances. The 2026-06-14/15 full-book coverage came from the manual escape hatch scripts/refresh-customer-segments.ts (raw pg, no cap).",
      owner: "cmo",
      parent: "[[../functions/cmo]] — owned-channel SMS marketing (Twilio) is CMO's; segment freshness is the audience layer under it. Builder is Ada/Platform per [[../functions/platform]].",
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Whole-book coverage",
          why: "The cron must refresh every subscriber each run; today it stops after one 1000-row page because the page size exceeds the PostgREST row cap and 'fewer than requested' is misread as 'last page'.",
          what: "The daily refresh advances through the entire keyset until a page genuinely returns zero rows, regardless of the server's per-request row cap.",
          body: "In src/lib/inngest/refresh-customer-segments.ts: the keyset page fetch (line ~106-107) requests .limit(STEP_BATCH=2000) but the client caps at 1000, so processBatch returns 1000 rows and line ~198 (`nextCursor = batch.length < limit ? null : batch[last]`) nulls the cursor after page 1. Fix so the loop covers the whole book. Two acceptable approaches: (a) set STEP_BATCH to 1000 (≤ the real cap) so batch.length === limit on full pages and the cursor keeps advancing — the exact-multiple final page is already handled by the `if (!idRows?.length) return nextCursor=null` guard at line ~111; or (b) fetch with explicit .range(0, STEP_BATCH-1) / paginated range that actually returns the requested count, and decide 'done' only when a page returns 0 rows (never infer 'done' from a short page that may just be the server cap). Keep the fan-out step-per-page architecture and MAX_PAGES backstop (line 49). Mirror any page-size decision in the manual escape hatch comment. Update the brain page docs/brain/inngest/refresh-customer-segments.md to document the PostgREST 1000-row cap gotcha and the fixed page-size invariant (CLAUDE.md brain-page-in-same-PR rule).",
          verification: "After one full cron run of refresh-workspace-segments for the Superfoods workspace, a probe of public.customers shows ≥99% of sms_marketing_status='subscribed' rows with segments_refreshed_at within the last 26 hours, and a segments_refreshed_at-by-day histogram shows a single fresh cohort spanning the whole book (not a ~1000-row cohort atop a stale tail). The processBatch cursor loop visits ≥ ceil(subscribers/pageSize) pages (probe the run's page count or assert segments_refreshed_at coverage), not 1.",
          status: "planned",
        },
        {
          title: "Phase 2 — Staleness alarm",
          why: "This regressed silently and sat ~20 days before a human noticed. A coverage signal must make a stuck refresh visible within a day.",
          what: "The refresh cron reports how much of the book it actually freshened, and a monitor/alarm trips when coverage drops or the oldest segment snapshot ages past a threshold.",
          body: "Extend the end-of-run heartbeat at src/lib/inngest/refresh-customer-segments.ts:257-259 (emitCronHeartbeat('refresh-customer-segments-cron', {ok, produced})) so `produced` carries the coverage number — e.g. subscribers processed vs total SMS-subscribed, or the count with segments_refreshed_at within 26h. Add a Control Tower monitor (or a cheap scheduled probe) that flags red when freshest-cohort coverage < ~95% of the subscribable book OR max(age of segments_refreshed_at over subscribed rows) > 48h — i.e. a check that would have caught the current 1000/138K state. If a monitor row/config table is used, add its brain page per CLAUDE.md.",
          verification: "The heartbeat payload for refresh-customer-segments-cron includes a coverage/processed field (inspect the emitted produced object or its stored heartbeat row). A probe or monitor exists that, run against a deliberately stale fixture (or the pre-fix production state), returns a red/alert verdict; run against a freshly-refreshed book it returns green.",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo" },
  );
  console.log(ok ? "authored" : "author write failed");
  const s = await getSpec(WORKSPACE_ID, "fix-segment-refresh-coverage");
  console.log("status:", s?.status, "| owner:", s?.owner, "| phases:", s?.phases?.length);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
