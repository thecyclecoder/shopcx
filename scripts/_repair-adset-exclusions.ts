/**
 * Repair the legacy test adsets that were minted WITHOUT existing-customer exclusions, and stamp
 * `meta_adsets.clean_signal_since` so the crown discounts everything they banked while contaminated.
 *
 * CEO 2026-08-25, option (b). Three adsets (47-49 days old) predate the exclusion feature, so
 * existing customers could convert inside a "cold" test — inflating purchases and flattering CPA,
 * which is the exact number the crown rests on. `crownUpperBoundCpaCents` guards a SMALL sample,
 * not a CONTAMINATED one.
 *
 * NOT retired, because neither is fatigued — Test 02's CTR nearly DOUBLED (1.21% → 2.39%) with
 * frequency FALLING (1.41 → 1.34) and an engine fatigue score of 0.18; skeptic-bloat is the same
 * shape. Retiring a proven, still-improving creative over a measurement problem would be the
 * expensive mistake. The normal cost of a mid-flight targeting edit is a learning-phase reset — but
 * we are permanently learning-limited anyway (2-8 conversions/adset/week vs Meta's ~50 exit), so
 * that reset costs essentially nothing here.
 *
 * Preserves each adset's existing targeting and ADDS the exclusions; never rewrites the spec.
 * IDEMPOTENT — skips an adset that already carries them. Pass --apply to write.
 */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken, getAdSetTargetingAndPixel, updateAdSetTargeting } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

/** The exclusion pair — owned by act_196487894712827 and SHARED across accounts (verified live:
 *  the Ashwavana adsets in act_2395577783853111 carry these same ids and Meta accepted them). */
const EXCLUSIONS = [{ id: "120250451196720326" }, { id: "120250451207710326" }];

const TARGETS = [
  { id: "120250066584430326", label: "MB Tabs — Test 02 (the crown candidate)" },
  { id: "120250143054030326", label: "MB Tabs · skeptic-bloat" },
  { id: "", label: "Amazing Creamer · before_after (resolved at runtime)" },
];

async function main() {
  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no Meta token");

  // Resolve the Creamer adset by name rather than hardcoding a volatile id.
  const { data: creamer } = await admin.from("meta_adsets")
    .select("meta_adset_id,name").eq("workspace_id", WS)
    .ilike("name", "%Amazing Creamer%before_after%").eq("effective_status", "ACTIVE").maybeSingle();
  if (creamer) TARGETS[2] = { id: String(creamer.meta_adset_id), label: `${creamer.name}` };
  else TARGETS.pop();

  const repaired: Array<Record<string, unknown>> = [];
  for (const t of TARGETS) {
    if (!t.id) continue;
    const cur = await getAdSetTargetingAndPixel(token, t.id);
    const targeting = { ...((cur?.targeting ?? {}) as Record<string, unknown>) };
    const existing = (targeting.excluded_custom_audiences ?? []) as Array<Record<string, unknown>>;

    console.log(`\n${t.label}  [${t.id}]`);
    if (Array.isArray(existing) && existing.length) {
      console.log(`  already excluded: ${JSON.stringify(existing.map((e) => String(e.id)))} — no-op`);
      continue;
    }
    console.log(`  no exclusions → adding ${EXCLUSIONS.map((e) => e.id).join(", ")}`);
    if (!APPLY) continue;

    targeting.excluded_custom_audiences = EXCLUSIONS;
    await updateAdSetTargeting(token, t.id, targeting);
    console.log(`  ✅ targeting updated on Meta`);

    const nowIso = new Date().toISOString();
    const { error } = await admin.from("meta_adsets")
      .update({ clean_signal_since: nowIso })
      .eq("workspace_id", WS).eq("meta_adset_id", t.id);
    if (error) throw new Error(`clean_signal_since stamp failed: ${error.message}`);
    console.log(`  ✅ clean_signal_since = ${nowIso.slice(0, 10)} (insights STRICTLY AFTER this day count)`);
    repaired.push({ adset_id: t.id, label: t.label, clean_signal_since: nowIso });
  }

  if (APPLY && repaired.length) {
    await admin.from("director_activity").insert({
      workspace_id: WS,
      director_function: "growth",
      action_kind: "media_buyer_adset_signal_repaired",
      reason:
        `CEO 2026-08-25: added existing-customer exclusions to ${repaired.length} legacy test adset(s) minted before ` +
        `the exclusion feature, and stamped clean_signal_since so the crown discounts the purchases they banked while ` +
        `contaminated. Kept rather than retired because neither is fatigued (Test 02 CTR 1.21%→2.39% with frequency ` +
        `FALLING 1.41→1.34, engine fatigue 0.18) — the CPA drift on skeptic-bloat tracks its budget scale, not burnout.`,
      metadata: { repaired, exclusions: EXCLUSIONS.map((e) => e.id), autonomous: false },
    });
    console.log(`\n✅ director_activity audit row written`);
  }
  console.log(`\n${APPLY ? "APPLIED" : "DRY RUN (pass --apply)"}: ${repaired.length} repaired`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
