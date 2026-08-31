/**
 * Did the system's OWN age fix (merged 2026-08-27) actually stop the failures, and what did my
 * later change add on top? Establishes the timeline rather than assuming.
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();
  const { data, error } = await a.from("ad_publish_jobs")
    .select("id,publish_status,meta_adset_id,created_at,error,create_adset_spec,origin")
    .eq("workspace_id", WS).eq("origin", "media-buyer-test")
    .gte("created_at", "2026-08-25T00:00:00Z").order("created_at");
  if (error) throw new Error(error.message);

  console.log("media-buyer-test publish jobs since Aug 25:");
  let lastFail = "";
  let mintedAfter = 0, failedAfter = 0;
  const FIX_MERGED = "2026-08-27T12:25";
  for (const j of data ?? []) {
    const spec = (j.create_adset_spec ?? {}) as Record<string, unknown>;
    const tg = (spec.targeting ?? {}) as Record<string, unknown>;
    const when = String(j.created_at).slice(0, 16);
    const after = when > FIX_MERGED;
    if (String(j.publish_status) === "failed") { lastFail = when; if (after) failedAfter += 1; }
    else if (j.meta_adset_id && after) mintedAfter += 1;
    console.log(`  ${when} ${String(j.publish_status).padEnd(10)} adset=${(j.meta_adset_id ?? "NONE").toString().slice(-10).padEnd(10)} age ${tg.age_min ?? "—"}-${tg.age_max ?? "—"}${after ? "  (after the fix)" : ""}`);
  }
  console.log(`\n  last FAILED mint: ${lastFail || "none"}`);
  console.log(`  fix merged ~${FIX_MERGED} (normalizeLegacyAdvantageAudienceTargeting, agent.ts:3702)`);
  console.log(`  after the fix → ${mintedAfter} minted, ${failedAfter} failed`);
  console.log(`\n  ⇒ ${failedAfter === 0 ? "the system's own fix HELD — no failure after it merged." : "failures CONTINUED after the fix."}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
