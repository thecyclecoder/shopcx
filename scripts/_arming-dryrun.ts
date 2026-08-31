/**
 * Would the cold-scaler arming gate ALLOW today, or does wiring it just produce a denial?
 *
 * Wiring `runColdScalerArmingGate` only fixes the graduate if the gate can actually clear. This
 * evaluates the PURE gate against the real preconditions WITHOUT writing an authorization row or
 * firing the CEO escalation the DB path emits on deny.
 *
 * Precondition #1 reads graded SCALE-vocabulary rows from
 * [[media_buyer_action_grades]] (Phase 3 of
 * cold-scaler-arming-decides-on-evidence-not-absence), not shadow reviews.
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import {
  evaluateColdScalerArmingPure,
  ARMING_GATE_LOOKBACK_DAYS,
  MIN_GRADED_SCALE_ACTIONS,
  MIN_SCALE_PASS_RATE,
  MIN_CONSECUTIVE_GREEN_TRUST,
  SCALE_ACTION_KINDS,
  SCALE_GRADE_PASS_THRESHOLD,
  DEFAULT_COLD_SCALER_CAC_LTV_TARGET,
  type GradedScaleActionInput,
  type ScaleActionKind,
} from "../src/lib/media-buyer/cold-scaler-arming-gate";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const since = new Date(Date.now() - ARMING_GATE_LOOKBACK_DAYS * 86400_000).toISOString();

  console.log(
    `thresholds: >=${MIN_GRADED_SCALE_ACTIONS} graded scale-actions (${SCALE_ACTION_KINDS.join(" | ")}) · >=${(MIN_SCALE_PASS_RATE * 100).toFixed(0)}% pass rate (overall_grade>=${SCALE_GRADE_PASS_THRESHOLD}) · >=${MIN_CONSECUTIVE_GREEN_TRUST} consecutive green trust days · CAC:LTV target ${DEFAULT_COLD_SCALER_CAC_LTV_TARGET}`,
  );
  console.log(`lookback: ${ARMING_GATE_LOOKBACK_DAYS}d (since ${since.slice(0, 10)})\n`);

  const { data: gradeRows, error: ge } = await admin
    .from("media_buyer_action_grades")
    .select("overall_grade, graded_at, action_kind")
    .eq("workspace_id", WS)
    .in("action_kind", SCALE_ACTION_KINDS as unknown as string[])
    .gte("graded_at", since);
  if (ge) {
    console.log(`media_buyer_action_grades read failed: ${ge.message}`);
  }
  const grades: GradedScaleActionInput[] = (gradeRows ?? [])
    .filter(
      (r): r is { overall_grade: number; graded_at: string; action_kind: ScaleActionKind } =>
        typeof (r as { overall_grade?: unknown }).overall_grade === "number" &&
        typeof (r as { graded_at?: unknown }).graded_at === "string" &&
        (SCALE_ACTION_KINDS as readonly string[]).includes(
          (r as { action_kind?: string }).action_kind ?? "",
        ),
    )
    .map((r) => ({
      overallGrade: r.overall_grade,
      gradedAt: r.graded_at,
      actionKind: r.action_kind,
    }));
  console.log(
    `media_buyer_action_grades (scale kinds, last ${ARMING_GATE_LOOKBACK_DAYS}d): ${grades.length}`,
  );

  const { count: gradeAll } = await admin
    .from("media_buyer_action_grades")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", WS);
  console.log(`media_buyer_action_grades (all kinds, all time):     ${gradeAll ?? 0}`);

  const { count: trustCount, error: te } = await admin
    .from("media_buyer_sensor_trust")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", WS);
  console.log(
    `media_buyer_sensor_trust (all time):                ${te ? `ERROR ${te.message}` : trustCount}`,
  );

  const { data: cac } = await admin
    .from("media_buyer_cold_scaler_cac_ltv_snapshots")
    .select("*")
    .eq("workspace_id", WS)
    .order("created_at", { ascending: false })
    .limit(1);
  console.log(
    `media_buyer_cold_scaler_cac_ltv_snapshots newest:   ${(cac ?? []).length ? JSON.stringify(cac![0]).slice(0, 160) : "NONE"}`,
  );

  // Evaluate the pure gate on today's real inputs. When trust + CAC:LTV are still
  // unfed the gate still denies — with reason codes that name the missing feeds.
  const res = evaluateColdScalerArmingPure({
    gradedScaleActions: grades,
    trustSnapshots: [],
    cacLtv: { cacLtvRatio: null, target: DEFAULT_COLD_SCALER_CAC_LTV_TARGET },
  });

  console.log(`\n=== PURE GATE VERDICT ON TODAY'S DATA ===`);
  console.log(`  allowed: ${res.allowed}`);
  for (const r of res.reasons) console.log(`  ✗ ${r.code.padEnd(36)} ${r.detail}`);
  console.log(`  metrics: ${JSON.stringify(res.metrics)}`);
  console.log(`\n  ⇒ wiring the gate makes it EVALUATE. Whether it ALLOWS is a separate question,`);
  console.log(`    and these are the preconditions that decide it.`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
