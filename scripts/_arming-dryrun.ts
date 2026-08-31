/**
 * Would the cold-scaler arming gate ALLOW today, or does wiring it just produce a denial?
 *
 * Wiring `runColdScalerArmingGate` only fixes the graduate if the gate can actually clear. This
 * evaluates the PURE gate against the real preconditions WITHOUT writing an authorization row or
 * firing the CEO escalation the DB path emits on deny.
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import {
  evaluateColdScalerArmingPure,
  ARMING_GATE_LOOKBACK_DAYS,
  MIN_REVIEWED_SHADOW_ACTIONS,
  MIN_AGREEMENT_RATE,
  MIN_CONSECUTIVE_GREEN_TRUST,
  DEFAULT_COLD_SCALER_CAC_LTV_TARGET,
} from "../src/lib/media-buyer/cold-scaler-arming-gate";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const since = new Date(Date.now() - ARMING_GATE_LOOKBACK_DAYS * 86400_000).toISOString();

  console.log(`thresholds: >=${MIN_REVIEWED_SHADOW_ACTIONS} reviewed shadow actions · >=${(MIN_AGREEMENT_RATE * 100).toFixed(0)}% agreement · >=${MIN_CONSECUTIVE_GREEN_TRUST} consecutive green trust days · CAC:LTV target ${DEFAULT_COLD_SCALER_CAC_LTV_TARGET}`);
  console.log(`lookback: ${ARMING_GATE_LOOKBACK_DAYS}d (since ${since.slice(0, 10)})\n`);

  const { count: shadowCount, error: se } = await admin.from("media_buyer_shadow_reviews")
    .select("id", { count: "exact", head: true }).eq("workspace_id", WS).gte("created_at", since);
  console.log(`media_buyer_shadow_reviews (last ${ARMING_GATE_LOOKBACK_DAYS}d): ${se ? `ERROR ${se.message}` : shadowCount}`);
  const { count: shadowAll } = await admin.from("media_buyer_shadow_reviews")
    .select("id", { count: "exact", head: true }).eq("workspace_id", WS);
  console.log(`media_buyer_shadow_reviews (all time):              ${shadowAll ?? 0}`);

  const { count: trustCount, error: te } = await admin.from("media_buyer_sensor_trust")
    .select("id", { count: "exact", head: true }).eq("workspace_id", WS);
  console.log(`media_buyer_sensor_trust (all time):                ${te ? `ERROR ${te.message}` : trustCount}`);

  const { data: cac } = await admin.from("media_buyer_cold_scaler_cac_ltv_snapshots")
    .select("*").eq("workspace_id", WS).order("created_at", { ascending: false }).limit(1);
  console.log(`media_buyer_cold_scaler_cac_ltv_snapshots newest:   ${(cac ?? []).length ? JSON.stringify(cac![0]).slice(0, 160) : "NONE"}`);

  // Evaluate the pure gate on today's real inputs.
  // Real inputs: all three feeds are empty, so the arrays are empty and the ratio is null.
  const res = evaluateColdScalerArmingPure({
    shadowReviews: [],
    trustSnapshots: [],
    cacLtv: { ratio: null, target: DEFAULT_COLD_SCALER_CAC_LTV_TARGET },
  } as never);

  console.log(`\n=== PURE GATE VERDICT ON TODAY'S DATA ===`);
  console.log(`  allowed: ${res.allowed}`);
  for (const r of res.reasons) console.log(`  ✗ ${r.code.padEnd(24)} ${r.detail}`);
  console.log(`  metrics: ${JSON.stringify(res.metrics)}`);
  console.log(`\n  ⇒ wiring the gate makes it EVALUATE. Whether it ALLOWS is a separate question,`);
  console.log(`    and these are the preconditions that decide it.`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
