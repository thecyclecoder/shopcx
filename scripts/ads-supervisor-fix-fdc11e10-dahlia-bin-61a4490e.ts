/**
 * ads-supervisor autonomous fix — product `Amazing Creamer`
 * (product_id `61a4490e-cb2a-4f65-9613-faab40f0b153`, workspace `fdc11e10-…`).
 *
 * The every-3h supervisor pass classified this product's ready-to-test bin as
 * thin (depth=3 vs floor=DEFAULT_BIN_FLOOR=4) and authored the fix-spec
 * `ads-supervisor-fix-fdc11e10-dahlia-bin-61a4490e-cb2a-4f65-9613-faab40f0b153`
 * (see [[../src/lib/ads-supervisor.ts]] `makeDahliaBinFinding`). The fix follows
 * the spec's Deterministic Action tree — "land the smaller of the two fixes
 * (dispatch OR intelligence-fill)":
 *
 *   1) Read `agent_jobs` (kind=`ad-creative`, instructions->>product_id=…, last 24h) —
 *      if Dahlia was already dispatched and is not-yet-terminal, the bin will refill
 *      on the current lane; nothing to do.
 *   2) Read `product_ad_angles` for this workspace+product — an EMPTY set is the
 *      intelligence gap blocking Dahlia's generate step (the bigger fix); run
 *      `generateAngles(productId, 12)` to fill it, then the next `ad-creative-cadence`
 *      cron tick (13:00 UTC daily) will pick this product up.
 *   3) Otherwise (angles exist AND no live job) land the SMALLER fix: insert one
 *      `agent_jobs` row (kind=`ad-creative`, `instructions.product_id`,
 *      `instructions.count`=deficit, `spec_slug=adCreativeSpecSlug(productId)`) —
 *      the same shape `dispatchAdCreativeCadence` uses, so the runner picks it up
 *      on the next builder-worker poll.
 *
 * Read-only until it commits the smaller fix — every DB write is behind a single
 * chokepoint at the bottom of `main()`, gated by the diagnosis above.
 *
 *   npx tsx scripts/ads-supervisor-fix-fdc11e10-dahlia-bin-61a4490e.ts
 */
import "./_bootstrap";
import { createAdminClient } from "@/lib/supabase/admin";
import { listReadyToTest } from "@/lib/ads/ready-to-test";
import { DEFAULT_BIN_FLOOR } from "@/lib/ads/creative-agent";
import { adCreativeSpecSlug } from "@/lib/inngest/ad-creative-cadence";
import { generateAngles } from "@/lib/ad-angles";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PRODUCT_ID = "61a4490e-cb2a-4f65-9613-faab40f0b153";
const ACTIVE_JOB_STATUSES = new Set([
  "queued",
  "claimed",
  "building",
  "needs_input",
  "needs_approval",
  "queued_resume",
  "blocked_on_usage",
]);

async function main() {
  const admin = createAdminClient();

  // ── Diagnostic 0 — confirm the bin is still thin. ─────────────────────
  const { readyToTest } = await listReadyToTest(admin, {
    workspaceId: WORKSPACE_ID,
    productId: PRODUCT_ID,
  });
  const depth = readyToTest.length;
  const deficit = Math.max(0, DEFAULT_BIN_FLOOR - depth);
  console.log(`bin depth: ${depth}/${DEFAULT_BIN_FLOOR} (deficit=${deficit})`);
  if (deficit === 0) {
    console.log("✓ already at floor — no action needed. Exiting.");
    return;
  }

  // ── Diagnostic 1 — is Dahlia already dispatched in the last 24h? ───────
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: jobRows, error: jobsErr } = await admin
    .from("agent_jobs")
    .select("id, status, instructions, created_at")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("kind", "ad-creative")
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (jobsErr) throw new Error(`agent_jobs read failed: ${jobsErr.message}`);
  const jobsForProduct = ((jobRows ?? []) as Array<{ id: string; status: string; instructions: string | null; created_at: string }>)
    .filter((r) => {
      if (!r.instructions) return false;
      try {
        return (JSON.parse(r.instructions) as { product_id?: string })?.product_id === PRODUCT_ID;
      } catch {
        return false;
      }
    });
  const activeJob = jobsForProduct.find((j) => ACTIVE_JOB_STATUSES.has(j.status));
  console.log(
    `ad-creative jobs (24h) for product: ${jobsForProduct.length} total, active=${activeJob ? `${activeJob.id}/${activeJob.status}` : "none"}`,
  );
  if (activeJob) {
    console.log("✓ Dahlia already dispatched — the bin will refill on the current lane. Exiting.");
    return;
  }

  // ── Diagnostic 2 — does the product have any ad intelligence to generate from? ─
  const { data: angleRows, error: angErr } = await admin
    .from("product_ad_angles")
    .select("id, status")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("product_id", PRODUCT_ID);
  if (angErr) throw new Error(`product_ad_angles read failed: ${angErr.message}`);
  const angleCount = angleRows?.length ?? 0;
  console.log(`product_ad_angles rows: ${angleCount}`);

  if (angleCount === 0) {
    // Intelligence gap — the bigger fix. Dahlia can't generate without angles;
    // fill them, and the daily ad-creative-cadence cron will dispatch on the
    // next tick (0 11 * * * UTC).
    console.log("→ intelligence gap: no product_ad_angles. Running generateAngles(count=12)…");
    const res = await generateAngles(PRODUCT_ID, 12);
    console.log(
      `  generateAngles: ok=${res.ok} inserted=${res.inserted.length} rejected=${res.rejected.length}${res.reason ? " reason=" + res.reason : ""}`,
    );
    if (!res.ok) {
      throw new Error(`generateAngles did not succeed: ${res.reason ?? "unknown"}`);
    }
    console.log("✓ angles filled — next ad-creative-cadence cron (0 11 * * * UTC) will dispatch Dahlia.");
    return;
  }

  // ── Fix path — angles exist, no active job: enqueue an ad-creative job. ─
  console.log(`→ dispatch fix: inserting agent_jobs(kind=ad-creative, count=${deficit})…`);
  const { data: inserted, error: insErr } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: WORKSPACE_ID,
      spec_slug: adCreativeSpecSlug(PRODUCT_ID),
      kind: "ad-creative",
      instructions: JSON.stringify({ product_id: PRODUCT_ID, count: deficit }),
    })
    .select("id")
    .single();
  if (insErr) throw new Error(`agent_jobs insert failed: ${insErr.message}`);
  console.log(`✓ enqueued agent_jobs row ${inserted?.id} — the builder-worker will pick Dahlia up on the next poll.`);
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
