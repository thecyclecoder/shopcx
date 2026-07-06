/**
 * Commerce SDK differential harness — Phase 1 sampler.
 *
 * Reads three cohorts of subscriptions from prod (via the service-role client)
 * and persists them as JSON for the downstream differential + shadow-run steps:
 *
 *   • internal      — `subscriptions.is_internal = true`
 *   • appstle       — `subscriptions.is_internal = false` (all Appstle contracts)
 *   • grandfathered — `is_internal = false` AND at least one Appstle contract
 *                     line has `pricingPolicy === null`, detected via the SAME
 *                     `inferAppstleLineBase` heuristic the heal + migration
 *                     paths use (docs/brain/libraries/appstle-pricing.md §
 *                     Overcharge remediation). A line is grandfathered when
 *                     the inferred true base is below catalog MSRP.
 *
 * READ-ONLY BY CONSTRUCTION:
 *   - Every Supabase call is `.select()` — never `.insert/.update/.delete`.
 *   - Appstle contracts are fetched via raw `fetch()` (NOT `loggedAppstleFetch`),
 *     so no rows land in `appstle_call_log` during the sample run. This
 *     preserves the DB-write-audit verification (zero rows written).
 *
 * Persists the cohort JSON to `/tmp/commerce-sample-<ts>.json`.
 *
 * Usage:
 *   npx tsx scripts/commerce-diff-sample.ts \
 *     [--workspace=<uuid>] [--per-cohort=50] [--appstle-scan=500] \
 *     [--out=/path/to/file.json]
 *
 * Defaults:
 *   --per-cohort=50 (verification requires ≥ 50 per cohort)
 *   --appstle-scan=25000 (max candidate Appstle subs to inspect, paginated
 *     oldest-first — grandfathering historically lives in migration-era subs;
 *     heal-on-touch has since structured most recent contracts, so a
 *     newest-first sweep of a few hundred rows will not surface any and
 *     the cohort defaults to 0. Paginated oldest-first + a materially larger
 *     cap keeps the default fill against the pinned baseline workspace).
 */
import { writeFileSync } from "fs";
import { createAdminClient } from "./_bootstrap";
import { decrypt } from "@/lib/crypto";
import { inferAppstleLineBase, resolveLineSnsPct, type AppstleLine } from "@/lib/appstle-pricing";

type Admin = ReturnType<typeof createAdminClient>;

interface Args {
  workspace?: string;
  perCohort: number;
  appstleScan: number;
  outPath?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { perCohort: 50, appstleScan: 25_000 };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--workspace=")) out.workspace = a.slice("--workspace=".length);
    else if (a.startsWith("--per-cohort=")) out.perCohort = Math.max(1, parseInt(a.slice("--per-cohort=".length), 10));
    else if (a.startsWith("--appstle-scan=")) out.appstleScan = Math.max(1, parseInt(a.slice("--appstle-scan=".length), 10));
    else if (a.startsWith("--out=")) out.outPath = a.slice("--out=".length);
  }
  return out;
}

async function pickLargestWorkspace(admin: Admin): Promise<string | null> {
  const { data, error } = await admin.from("subscriptions").select("workspace_id").limit(50_000);
  if (error) throw error;
  const counts = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ workspace_id: string }>) {
    counts.set(r.workspace_id, (counts.get(r.workspace_id) || 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [wsId, n] of counts.entries()) {
    if (n > bestCount) { best = wsId; bestCount = n; }
  }
  return best;
}

interface SubRow {
  id: string;
  workspace_id: string;
  shopify_contract_id: string | null;
  status: string;
  is_internal: boolean;
}

async function sampleByInternalFlag(admin: Admin, workspaceId: string, isInternal: boolean, limit: number): Promise<SubRow[]> {
  const { data, error } = await admin
    .from("subscriptions")
    .select("id, workspace_id, shopify_contract_id, status, is_internal")
    .eq("workspace_id", workspaceId)
    .eq("is_internal", isInternal)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as SubRow[];
}

async function getAppstleApiKey(admin: Admin, workspaceId: string): Promise<string | null> {
  const { data: ws, error } = await admin
    .from("workspaces")
    .select("appstle_api_key_encrypted")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  const enc = (ws?.appstle_api_key_encrypted as string | null | undefined) ?? null;
  return enc ? decrypt(enc) : null;
}

interface AppstleContract {
  status?: string;
  lines?: { nodes?: AppstleLine[]; edges?: Array<{ node: AppstleLine }> };
}

async function fetchAppstleContract(apiKey: string, contractId: string): Promise<AppstleContract | null> {
  const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${apiKey}`;
  try {
    // Raw fetch (NOT loggedAppstleFetch) — keeps the sample run write-free.
    const r = await fetch(url, { headers: { "X-API-Key": apiKey }, cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json().catch(() => null)) as AppstleContract | null;
  } catch {
    return null;
  }
}

function extractLines(contract: AppstleContract): AppstleLine[] {
  const nodes = contract.lines?.nodes;
  if (Array.isArray(nodes)) return nodes;
  const edges = contract.lines?.edges;
  if (Array.isArray(edges)) return edges.map((e) => e.node);
  return [];
}

async function catalogForVariant(admin: Admin, shopifyVariantId: string): Promise<{ productId: string | null; msrpCents: number } | null> {
  const { data, error } = await admin
    .from("product_variants")
    .select("product_id, price_cents")
    .eq("shopify_variant_id", shopifyVariantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { productId: (data.product_id as string) || null, msrpCents: (data.price_cents as number) || 0 };
}

/**
 * True when at least one Appstle contract line is grandfathered under the
 * `inferAppstleLineBase` heuristic — i.e., pricingPolicy was null AND the
 * reverse-engineered true base sits below catalog MSRP. Matches the
 * "Overcharge remediation" section of docs/brain/libraries/appstle-pricing.md.
 */
async function isContractGrandfathered(admin: Admin, workspaceId: string, contract: AppstleContract): Promise<boolean> {
  if (!contract || contract.status === "CANCELLED") return false;
  for (const line of extractLines(contract)) {
    if (line.pricingPolicy?.basePrice?.amount != null) continue; // structured — skip
    const shopifyVariantId = String(line.variantId || "").split("/").pop() || "";
    if (!shopifyVariantId) continue;
    const cat = await catalogForVariant(admin, shopifyVariantId);
    if (!cat || cat.msrpCents <= 0) continue;
    const snsPct = await resolveLineSnsPct(admin, workspaceId, cat.productId);
    const inferred = inferAppstleLineBase(line, cat.msrpCents, snsPct);
    if (inferred.isGrandfathered) return true;
  }
  return false;
}

interface CohortManifest {
  generated_at: string;
  workspace_id: string;
  per_cohort_target: number;
  appstle_scan_target: number;
  cohorts: {
    internal: SubRow[];
    appstle: SubRow[];
    grandfathered: SubRow[];
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const admin = createAdminClient();

  const workspaceId = args.workspace ?? (await pickLargestWorkspace(admin));
  if (!workspaceId) {
    console.error("FAIL: no workspace with subscriptions found — pass --workspace=<uuid>");
    process.exit(1);
  }
  console.log(`workspace=${workspaceId} per-cohort=${args.perCohort} appstle-scan=${args.appstleScan}`);

  // Cohort A — internal.
  const internal = await sampleByInternalFlag(admin, workspaceId, true, args.perCohort);
  console.log(`cohort internal: ${internal.length}`);

  // Cohort B — Appstle (is_internal=false).
  const appstle = await sampleByInternalFlag(admin, workspaceId, false, args.perCohort);
  console.log(`cohort appstle: ${appstle.length}`);

  // Cohort C — grandfathered subset of the Appstle cohort.
  //
  // Ordering matters: grandfathering historically lives in migration-era subs
  // (Appstle's original migration wrote `pricingPolicy = null` on the oldest
  // contracts — see docs/brain/libraries/appstle-pricing.md § Overcharge
  // remediation). Recent contracts have almost all been structured by
  // heal-on-touch, so a newest-first sweep finds zero null-policy lines and
  // the cohort defaults to 0. Paginate OLDEST-FIRST in chunks and early-exit
  // as soon as the cohort fills, up to `--appstle-scan` total candidates.
  const grandfathered: SubRow[] = [];
  let candidatesScanned = 0;
  const apiKey = await getAppstleApiKey(admin, workspaceId);
  if (!apiKey) {
    console.warn("WARN: workspace has no Appstle API key — grandfathered cohort will be empty");
  } else {
    const pageSize = 500;
    let offset = 0;
    outer: while (grandfathered.length < args.perCohort && offset < args.appstleScan) {
      const upper = Math.min(offset + pageSize, args.appstleScan) - 1;
      const { data: pageRaw, error } = await admin
        .from("subscriptions")
        .select("id, workspace_id, shopify_contract_id, status, is_internal")
        .eq("workspace_id", workspaceId)
        .eq("is_internal", false)
        .order("created_at", { ascending: true })
        .range(offset, upper);
      if (error) throw error;
      const page = (pageRaw ?? []) as SubRow[];
      if (page.length === 0) break; // exhausted the pool
      for (const sub of page) {
        candidatesScanned++;
        if (!sub.shopify_contract_id) continue;
        const contract = await fetchAppstleContract(apiKey, sub.shopify_contract_id);
        if (!contract) continue;
        if (await isContractGrandfathered(admin, workspaceId, contract)) {
          grandfathered.push(sub);
          if (grandfathered.length >= args.perCohort) break outer;
        }
      }
      if (page.length < pageSize) break; // last page — pool exhausted
      offset += pageSize;
    }
  }
  console.log(`cohort grandfathered: ${grandfathered.length} (scanned ${candidatesScanned} candidates)`);

  const manifest: CohortManifest = {
    generated_at: new Date().toISOString(),
    workspace_id: workspaceId,
    per_cohort_target: args.perCohort,
    appstle_scan_target: args.appstleScan,
    cohorts: { internal, appstle, grandfathered },
  };

  const outPath = args.outPath ?? `/tmp/commerce-sample-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`\nwrote ${outPath}`);

  // Report per the Phase-1 verification: ≥ 50 rows per cohort by default.
  const short: string[] = [];
  if (internal.length < args.perCohort) short.push(`internal=${internal.length}`);
  if (appstle.length < args.perCohort) short.push(`appstle=${appstle.length}`);
  if (grandfathered.length < args.perCohort) short.push(`grandfathered=${grandfathered.length}`);
  if (short.length > 0) {
    console.warn(`WARN: cohorts under target (${args.perCohort}): ${short.join(", ")} — the downstream diff runner will operate on the sampled subset.`);
  } else {
    console.log(`PASS: every cohort met the per-cohort target (${args.perCohort})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
