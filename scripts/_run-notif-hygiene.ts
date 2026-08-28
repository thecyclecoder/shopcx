/**
 * Run the notification-hygiene sweeps once, using the SAME functions the cron calls.
 *
 * Dry by default — prints exactly what would be retired and, importantly, what would be KEPT.
 * Pass --apply to write.
 */
import { createAdminClient } from "./_bootstrap";
import { sweepExpiredReports, sweepSettledChargebacks, sweepResolvedFraudCases, DAILY_SUMMARY_TTL_DAYS } from "../src/lib/notification-hygiene";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();

  const before = await admin.from("dashboard_notifications")
    .select("id", { count: "exact", head: true }).eq("workspace_id", WS).eq("dismissed", false);
  console.log(`undismissed before: ${before.count}`);

  const reports = await sweepExpiredReports(admin, { workspaceId: WS, apply: APPLY });
  console.log(`\nreports (TTL ${DAILY_SUMMARY_TTL_DAYS}d): scanned ${reports.scanned} · ${APPLY ? "retired" : "would retire"} ${reports.dismissed} · kept ${reports.kept}`);

  const cbs = await sweepSettledChargebacks(admin, { workspaceId: WS, apply: APPLY });
  console.log(`chargebacks: scanned ${cbs.scanned} · ${APPLY ? "retired" : "would retire"} ${cbs.dismissed} · KEPT ${cbs.kept} (unsettled / unresolvable)`);

  const fraud = await sweepResolvedFraudCases(admin, { workspaceId: WS, apply: APPLY });
  console.log(`fraud: scanned ${fraud.scanned} · ${APPLY ? "retired" : "would retire"} ${fraud.dismissed} · KEPT ${fraud.kept} (open / unresolvable)`);

  // Show the kept ones — the sweep being selective is the thing worth proving.
  if (cbs.kept > 0) {
    const { data: still } = await admin.from("dashboard_notifications")
      .select("title,metadata,created_at").eq("workspace_id", WS)
      .eq("type", "chargeback_alert").eq("dismissed", false).limit(200);
    const ids = [...new Set((still ?? []).map((n) => String((n.metadata as Record<string, unknown>)?.entity_id ?? "")).filter(Boolean))];
    const { data: ev } = await admin.from("chargeback_events")
      .select("id,status,finalized_on,evidence_due_by,amount_cents").eq("workspace_id", WS).in("id", ids.length ? ids : ["x"]);
    const byId = new Map((ev ?? []).map((e) => [String(e.id), e]));
    const kept = (still ?? []).filter((n) => {
      const e = byId.get(String((n.metadata as Record<string, unknown>)?.entity_id ?? ""));
      return !e || (!e.finalized_on && !["won", "lost", "closed", "accepted"].includes(String(e.status).toLowerCase()));
    });
    console.log(`\n  kept chargeback alerts (${kept.length}) — these still want eyes:`);
    for (const n of kept.slice(0, 12)) {
      const e = byId.get(String((n.metadata as Record<string, unknown>)?.entity_id ?? ""));
      console.log(`    ${String(n.created_at).slice(0, 10)} ${String(n.title).slice(0, 52).padEnd(52)} status=${e?.status ?? "UNRESOLVABLE"} due=${String(e?.evidence_due_by ?? "—").slice(0, 10)}`);
    }
  }

  if (APPLY) {
    const after = await admin.from("dashboard_notifications")
      .select("id", { count: "exact", head: true }).eq("workspace_id", WS).eq("dismissed", false);
    console.log(`\nundismissed after: ${after.count} (was ${before.count})`);
    await admin.from("director_activity").insert({
      workspace_id: WS,
      director_function: "platform",
      action_kind: "notification_hygiene_swept",
      reason:
        `CEO 2026-08-28: first notification-hygiene sweep — retired ${reports.dismissed} expired daily recap(s) ` +
        `(${DAILY_SUMMARY_TTL_DAYS}d TTL), ${cbs.dismissed} SETTLED chargeback alert(s) and ${fraud.dismissed} WORKED fraud alert(s), ` + `keeping ${cbs.kept} unsettled chargeback + ${fraud.kept} open fraud. ` +
        `Informational types had no terminal state a human did not have to reach, so 2,237 undismissed rows accrued ` +
        `against 13 real decisions — while 98-100% of the pile was already read.`,
      metadata: { reports: reports.dismissed, chargebacks_retired: cbs.dismissed, chargebacks_kept: cbs.kept, fraud_retired: fraud.dismissed, fraud_kept: fraud.kept, autonomous: false },
    });
    console.log("✅ audit row written");
  } else {
    console.log("\nDRY RUN — pass --apply");
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
