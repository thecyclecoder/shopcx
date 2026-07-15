/**
 * ads-supervisor fix — product `221d272d-a6c5-4a5d-86ff-ac693926c992` (Superfood
 * Tabs, workspace `fdc11e10-...`): the ready-to-test bin is thin (2 vs
 * DEFAULT_BIN_FLOOR of 4). Authored to satisfy fix-spec
 * `ads-supervisor-fix-fdc11e10-dahlia-bin-221d272d-a6c5-4a5d-86ff-ac693926c992`
 * (see [[../src/lib/ads-supervisor.ts]] `makeDahliaBinFinding`).
 *
 * The daily `ad-creative-cadence-cron` (0 11 UTC) already self-heals this — on its
 * next tick it enqueues one `kind='ad-creative'` job per product below floor. This
 * script exists so the fix can be applied on-demand (dry-run by default) and
 * produces the diagnostic the spec body requires:
 *   1) `agent_jobs` where `kind='ad-creative'` AND `instructions->>'product_id' = <PID>`
 *      over the last 24h — did Dahlia get dispatched?
 *   2) `product_ad_angles` scoped to `workspace_id` + `product_id` — an empty set
 *      is the intelligence gap blocking Dahlia's generate step.
 *   3) The smaller of the two fixes:
 *      - dispatch: enqueue one fresh `agent_jobs` row (same shape ad-creative-cadence uses)
 *      - intelligence-fill: surface the empty product_ad_angles gap (needs Carrie's
 *        dr-content lane; not auto-writable from this script).
 *
 * Idempotent — skips the enqueue if the product is already covered by a NOT-YET-TERMINAL
 * `kind='ad-creative'` job (matches ad-creative-cadence's ACTIVE_MEDIA_BUYER_JOB_STATUSES).
 * Dry-run by default; pass `--apply` to actually insert.
 *
 * Read-only against every other table; writes only one `agent_jobs` row on --apply.
 */
import { createAdminClient } from "./_bootstrap";
import { ACTIVE_MEDIA_BUYER_JOB_STATUSES } from "../src/lib/inngest/media-buyer-cadence";
import { adCreativeSpecSlug } from "../src/lib/inngest/ad-creative-cadence";
import { DEFAULT_BIN_FLOOR } from "../src/lib/ads/creative-agent";
import { listReadyToTest } from "../src/lib/ads/ready-to-test";
import { isAdvertisedProduct } from "../src/lib/advertised-products";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PRODUCT_ID = "221d272d-a6c5-4a5d-86ff-ac693926c992";
const LOOKBACK_HOURS = 24;

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  console.log(`ads-supervisor fix — product=${PRODUCT_ID} workspace=${WORKSPACE_ID}`);
  console.log(`mode: ${apply ? "APPLY (will insert one agent_jobs row if the fix is dispatch)" : "DRY-RUN (no writes)"}`);

  // Step 0 — confirm the product exists and is advertised (else this pass is a no-op).
  const { data: product, error: pErr } = await admin
    .from("products")
    .select("id, title, is_advertised, workspace_id")
    .eq("id", PRODUCT_ID)
    .maybeSingle();
  if (pErr) throw new Error(`products read failed: ${pErr.message}`);
  if (!product) {
    console.log(`✗ product ${PRODUCT_ID} not found — spec is stale, no fix to apply`);
    return;
  }
  const productRow = product as { id: string; title: string | null; is_advertised: boolean | null; workspace_id: string };
  console.log(`  product.title=${JSON.stringify(productRow.title)} is_advertised=${productRow.is_advertised} workspace=${productRow.workspace_id}`);
  if (productRow.workspace_id !== WORKSPACE_ID) {
    console.log(`✗ workspace mismatch — spec's fdc11e10 prefix ≠ ${productRow.workspace_id}`);
    return;
  }
  const advertised = await isAdvertisedProduct(admin, PRODUCT_ID);
  if (!advertised) {
    console.log(`✗ product is not is_advertised=true — ads-supervisor should not have flagged it; no fix`);
    return;
  }

  // Step 1 — current bin depth.
  const { readyToTest } = await listReadyToTest(admin, { workspaceId: WORKSPACE_ID, productId: PRODUCT_ID });
  const depth = readyToTest.length;
  const deficit = DEFAULT_BIN_FLOOR - depth;
  console.log(`\n[bin] listReadyToTest depth=${depth} floor=${DEFAULT_BIN_FLOOR} deficit=${deficit}`);
  if (deficit <= 0) {
    console.log(`✓ bin is at/above floor — drift already cleared; no fix needed`);
    return;
  }

  // Step 2 — did Dahlia get dispatched over the last LOOKBACK_HOURS?
  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const { data: recentJobs, error: jErr } = await admin
    .from("agent_jobs")
    .select("id, status, instructions, created_at")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("kind", "ad-creative")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false });
  if (jErr) throw new Error(`agent_jobs read failed: ${jErr.message}`);
  const matches = ((recentJobs ?? []) as Array<{ id: string; status: string; instructions: string | null; created_at: string }>)
    .filter((r) => {
      if (!r.instructions) return false;
      try {
        const parsed = JSON.parse(r.instructions) as { product_id?: unknown };
        return typeof parsed?.product_id === "string" && parsed.product_id === PRODUCT_ID;
      } catch { return false; }
    });
  const activeMatch = matches.find((r) => ACTIVE_MEDIA_BUYER_JOB_STATUSES.has(r.status));
  console.log(`\n[dispatch] agent_jobs kind='ad-creative' for this product in last ${LOOKBACK_HOURS}h: ${matches.length}`);
  for (const m of matches) console.log(`  - ${m.id} status=${m.status} created_at=${m.created_at}`);
  if (activeMatch) {
    console.log(`✓ product is already covered by active job ${activeMatch.id} (status=${activeMatch.status}) — no new dispatch needed`);
    return;
  }

  // Step 3 — product_ad_angles: intelligence gap check.
  const { data: angleRows, error: aErr } = await admin
    .from("product_ad_angles")
    .select("id")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("product_id", PRODUCT_ID);
  if (aErr) throw new Error(`product_ad_angles read failed: ${aErr.message}`);
  const angleCount = (angleRows ?? []).length;
  console.log(`\n[intelligence] product_ad_angles rows for this product: ${angleCount}`);
  if (angleCount === 0) {
    console.log(`✗ intelligence gap — zero product_ad_angles rows; dispatch would starve on Dahlia's generate step.`);
    console.log(`  fix: run Carrie's dr-content lane (or seed angles manually) — NOT auto-writable from this script.`);
    return;
  }

  // Step 4 — the "dispatch" fix is safe: angles exist and no active job covers this product.
  const specSlug = adCreativeSpecSlug(PRODUCT_ID);
  const instructions = JSON.stringify({ product_id: PRODUCT_ID, count: deficit });
  console.log(`\n[fix] enqueueing kind='ad-creative' spec_slug='${specSlug}' instructions=${instructions}`);
  if (!apply) {
    console.log(`(dry-run — pass --apply to insert)`);
    return;
  }
  const { data: inserted, error: insErr } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: WORKSPACE_ID,
      spec_slug: specSlug,
      kind: "ad-creative",
      instructions,
    })
    .select("id")
    .single();
  if (insErr) throw new Error(`agent_jobs insert failed: ${insErr.message}`);
  console.log(`✓ enqueued agent_jobs id=${(inserted as { id: string }).id}`);
}

main().catch((e) => { console.error("✗", e); process.exit(1); });
