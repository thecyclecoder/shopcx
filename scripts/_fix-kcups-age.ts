/**
 * Bring the K-Cups cohort's age targeting in line with every other cohort (CEO 2026-08-28).
 *
 * Meta rejected 10+ K-Cups mints across Aug 26-27 with:
 *   "With ad sets that use Advantage+ audience, the minimum age audience control can't be set to
 *    higher than 25."
 * The K-Cups template carries age 50-65 (a legacy older-buyer profile) while `advantage_audience=1`.
 * Every other active cohort is 18-65, which is what the CEO wants K-Cups on too.
 *
 * Consequence while it was broken: K-Cups was unblocked on 2026-08-25 (is_advertised + 12 angles),
 * Dahlia produced a creative, Bianca picked it up — and every single mint attempt was refused at the
 * last step. The product looked "wired" at every layer I checked and still could not launch.
 *
 * IDEMPOTENT compare-and-set. Pass --apply to write.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";
const APPLY = process.argv.includes("--apply");
const TARGET_MIN = 18, TARGET_MAX = 65;

async function main() {
  const admin = createAdminClient();

  // What every other active cohort uses — don't hardcode the norm, read it.
  const { data: cohorts, error } = await admin.from("media_buyer_test_cohorts")
    .select("id,product_id,adset_template,is_active").eq("workspace_id", WS).eq("is_active", true);
  if (error) throw new Error(`media_buyer_test_cohorts: ${error.message}`);
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  const title = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));

  console.log("current age targeting by cohort:");
  const others: string[] = [];
  for (const c of cohorts ?? []) {
    const tg = ((c.adset_template ?? {}) as Record<string, unknown>).targeting as Record<string, unknown> | undefined;
    const range = `${tg?.age_min ?? "?"}-${tg?.age_max ?? "?"}`;
    if (String(c.product_id) !== KCUPS) others.push(range);
    console.log(`  ${String(title.get(String(c.product_id)) ?? "?").padEnd(24)} ${range}${String(c.product_id) === KCUPS ? "   ← the outlier" : ""}`);
  }
  const norm = [...new Set(others)];
  console.log(`\n  every other cohort: ${norm.join(", ")}  ${norm.length === 1 && norm[0] === `${TARGET_MIN}-${TARGET_MAX}` ? "✅ consistent" : "⚠ not uniform — check before assuming a norm"}`);

  const k = (cohorts ?? []).find((c) => String(c.product_id) === KCUPS);
  if (!k) { console.log("\nno active K-Cups cohort"); return; }
  const tmpl = { ...((k.adset_template ?? {}) as Record<string, unknown>) };
  const tg = { ...((tmpl.targeting ?? {}) as Record<string, unknown>) };
  const curMin = Number(tg.age_min), curMax = Number(tg.age_max);

  if (curMin === TARGET_MIN && curMax === TARGET_MAX) { console.log("\nalready 18-65 — no-op"); return; }
  console.log(`\nK-Cups ${curMin}-${curMax} → ${TARGET_MIN}-${TARGET_MAX}`);
  if (!APPLY) { console.log("DRY RUN — pass --apply"); return; }

  tg.age_min = TARGET_MIN;
  tg.age_max = TARGET_MAX;
  tmpl.targeting = tg;
  const { error: uerr } = await admin.from("media_buyer_test_cohorts")
    .update({ adset_template: tmpl, updated_at: new Date().toISOString() })
    .eq("id", k.id).eq("workspace_id", WS);
  if (uerr) throw new Error(`update: ${uerr.message}`);
  console.log("✅ template updated");

  await admin.from("director_activity").insert({
    workspace_id: WS,
    director_function: "growth",
    action_kind: "media_buyer_cohort_age_targeting_repaired",
    reason:
      `CEO 2026-08-28: K-Cups cohort age targeting ${curMin}-${curMax} → ${TARGET_MIN}-${TARGET_MAX}, matching every other ` +
      `cohort. Meta refused 10+ mints across Aug 26-27: "With ad sets that use Advantage+ audience, the minimum age ` +
      `audience control can't be set to higher than 25." advantage_audience=1 caps age_min at 25, and the template ` +
      `carried a legacy 50-65 older-buyer profile. K-Cups had been unblocked on 08-25 and a creative was ready — every ` +
      `mint failed at the last step.`,
    metadata: { product_id: KCUPS, cohort_id: k.id, age: { from: [curMin, curMax], to: [TARGET_MIN, TARGET_MAX] }, autonomous: false },
  });
  console.log("✅ audit row written");
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
