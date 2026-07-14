/**
 * ads-supervisor — the every-3h supervisory pass that audits Bianca (the
 * [[./media-buyer/agent|media-buyer]]) + Dahlia (the [[./ads/creative-agent|ad-creative]]) worker
 * agents and REPAIRS drift by autonomously authoring fix-specs through
 * [[./author-spec]] `authorSpecRowStructured`. Same supervisable-autonomy north-star as the
 * media-buyer arming gate: this supervisor NEVER moves spend / pauses / crowns / places ads
 * directly — it PROPOSES fix-specs Bianca / Dahlia (or Bo the Build worker) consume, and posts
 * ONE consolidated digest to the founder's #director-growth-max channel. The pass runs from the
 * box worker's `runAdsSupervisorJob` lane (`scripts/builder-worker.ts`); Phase 1 wired the cron,
 * the lane, and the node-completeness trio (owner + kill-switch + heartbeat) and shipped a
 * heartbeat-only stub — THIS module is the Phase-2 pass logic.
 *
 * The 4 checks (spec [[../../docs/brain/specs/growth-ads-supervisor-3h-agent]] Phase 2):
 *
 *   1. Crown/kill drift — call [[./ads/testing-results-sdk]] `getTestingResults` with the
 *      workspace's live [[../../docs/brain/tables/iteration_policies]] thresholds. Any test in
 *      the `crown` tier that Bianca hasn't PROMOTED (no `iteration_actions` `scale_up` row for
 *      the adset) is a should-crown miss; any `dud` that Bianca hasn't PAUSED (no `pause` row)
 *      is a should-kill miss. Each miss authors one fix-spec.
 *   2. Dahlia bin depth + seeding — per hero product (any product with an active
 *      [[../../docs/brain/tables/media_buyer_test_cohorts]] cohort), call
 *      [[./ads/ready-to-test]] `listReadyToTest({productId})` and compare depth vs
 *      `DEFAULT_BIN_FLOOR` (4). Below-floor OR zero proven competitor angles for the product
 *      (via [[./ads/creative-sourcing]] `getProvenCompetitorAngles`) authors one fix-spec.
 *   3. Live-ad LF8 QA — for each live test creative in `getTestingResults` (Bianca IS placing
 *      test ads), rule-check the ad copy for at least one Life-Force-8 term + a destination URL
 *      whose product handle matches the cohort's product. Below the bar authors one fix-spec.
 *
 * Dedup: EVERY authored slug is checked against [[./specs-table]] `getSpec` FIRST (any status —
 * a still-active fix-spec for the same finding is enough to skip re-authoring); and
 * `agent_jobs` is scanned for a not-yet-terminal `repair` job on the same slug (parked repair
 * jobs cover the finding).
 *
 * Suppressed no-op: when the pass finds ZERO drift AND no fix-specs were authored, the Slack
 * digest is skipped entirely (per [[../../docs/brain/specs/media-buyer-digest-consolidate-product-names-suppress-noop]]
 * — don't spam #director-growth-max every 3h with "nothing to report").
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { getTestingResults, type ProductTestGroup, type TestAdsetRow } from "@/lib/ads/testing-results-sdk";
import { listReadyToTest } from "@/lib/ads/ready-to-test";
import { DEFAULT_BIN_FLOOR } from "@/lib/ads/creative-agent";
import { getProvenCompetitorAngles } from "@/lib/ads/creative-sourcing";
import { authorSpecRowStructured } from "@/lib/author-spec";
import { getSpec } from "@/lib/specs-table";
import type { SpecPhaseCheckInput } from "@/lib/spec-phase-checks-table";
import { getSlackToken, postAsGrowthDirector } from "@/lib/slack";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

/** The growth-function slug all authored fix-specs live under. Mirrors [[./mario]] `MARIO_DIRECTOR_FUNCTION`. */
const GROWTH_FUNCTION = "growth";
/** The Growth mandate that owns this supervisor's authored fix-specs
 * ([[../../docs/brain/functions/growth]] § "Static-ad optimization"). Same shape mario / blueprint-build
 * use — the author chokepoint's `assertValidParent` rejects a bare-function parent, so a typed mandate
 * `parentKind: "mandate"` + `parentRef: "<fn>#<slug>"` is required. */
const STATIC_AD_OPTIMIZATION_MANDATE_SLUG = "static-ad-optimization";
const STATIC_AD_OPTIMIZATION_MANDATE_REF = `${GROWTH_FUNCTION}#${STATIC_AD_OPTIMIZATION_MANDATE_SLUG}`;
const STATIC_AD_OPTIMIZATION_PARENT_PROSE =
  `[[../functions/growth]] — "Static-ad optimization" mandate: ads-supervisor autonomous fix so this drift class cannot recur.`;

/** Every fix-spec slug this supervisor authors starts with this prefix so the dedup + audit
 * are stable across passes. */
const FIX_SPEC_SLUG_PREFIX = "ads-supervisor-fix-";
/** Life-Force-8 keyword list (Dr. Whitman) — one-token lowercase forms so a simple substring
 * scan hits without a natural-language pass. Kept short + broadly-appealing; the point is to
 * catch a live ad whose copy has NONE of these (i.e. reads like a feature dump rather than a
 * benefit-driven acquisition ad). */
const LF8_KEYWORDS: readonly string[] = [
  // 1. survival / enjoyment of life / life extension
  "energy", "sleep", "health", "life", "years", "longevity", "vitality", "focus", "clarity", "wake",
  // 2. enjoyment of food/drink
  "delicious", "taste", "flavor", "coffee", "morning", "drink",
  // 3. freedom from fear/pain/danger
  "crash", "safe", "protect", "calm", "relief", "stress", "anxiety", "worry",
  // 4. sexual companionship — largely off-brand for the coffee vertical; kept out.
  // 5. comfortable living
  "easy", "smooth", "effortless", "comfortable",
  // 6. to be superior / win
  "boost", "beat", "power", "better", "unlock", "peak", "sharper",
  // 7. care and protection of loved ones
  "family", "kids", "loved", "share",
  // 8. social approval
  "trust", "proven", "loved by", "customers", "reviews",
];

// ── Finding shapes ──────────────────────────────────────────────────────────────

/** A single actionable finding — every one either authors a fix-spec (skipped if deduped) OR is
 * elided as a no-op line in the digest. */
export interface Finding {
  /** stable id used by the digest + audit; also the fix-spec slug's suffix. */
  id: string;
  kind: FindingKind;
  productId: string | null;
  productTitle: string;
  summary: string;
  /** Fix-spec plain-language WHY. */
  why: string;
  /** Fix-spec plain-language WHAT. */
  what: string;
  /** Fix-spec Phase-1 body. */
  body: string;
  /** Fix-spec Phase-1 verification bullets (the machine-check gate assertEveryPhaseHasMachineCheck
   * still needs a tsc check attached — carried via `checks` below). */
  verification: string;
}

export type FindingKind =
  | "bianca_missed_crown"
  | "bianca_missed_kill"
  | "dahlia_bin_below_floor"
  | "dahlia_zero_seeded_angles"
  | "live_ad_lf8_thin"
  | "live_ad_destination_mismatch";

/** Overall pass result — the digest composer + the audit log both read this. */
export interface AdsSupervisorResult {
  evaluated: {
    products: number;
    tests: number;
    biancaMisses: number;
    dahliaGaps: number;
    liveAdIssues: number;
  };
  findings: Finding[];
  /** slugs the pass ACTUALLY authored (deduped skips are NOT in here). */
  authoredSlugs: string[];
  /** slugs that were skipped as duplicates (existing spec or open repair job). */
  dedupedSlugs: string[];
  digest?: { posted: boolean; reason?: string; ts?: string };
}

// ── The pass ────────────────────────────────────────────────────────────────────

/**
 * Run the ads-supervisor pass for ONE workspace. Read-only against every SDK except the two write
 * chokepoints: `authorSpecRowStructured` (the structured spec-authoring gate) and
 * `postAsGrowthDirector` (the founder's Slack digest). NEVER writes to `iteration_actions`,
 * `ad_publish_jobs`, `ad_campaigns`, `meta_*`, or any live-ad surface.
 *
 * `nowMs` is threaded so tests can pin the pass to a fixed clock (the getTestingResults freshness
 * flags are timestamp-derived).
 */
export async function runAdsSupervisorPass(
  admin: Admin,
  workspaceId: string,
  nowMs: number = Date.now(),
): Promise<AdsSupervisorResult> {
  const results = await getTestingResults(admin, workspaceId, nowMs);
  const findings: Finding[] = [];
  let biancaMisses = 0;
  let dahliaGaps = 0;
  let liveAdIssues = 0;
  let testCount = 0;

  // ── 1. Crown/kill drift — did Bianca act on the tiered rows? ────────────────
  const productAdsetIds = new Set<string>();
  for (const group of results.products) {
    for (const row of group.rows) {
      productAdsetIds.add(row.adsetId);
      testCount += 1;
    }
  }
  const actedByAdset = await readIterationActionsForAdsets(admin, workspaceId, [...productAdsetIds]);

  for (const group of results.products) {
    for (const row of group.rows) {
      if (!row.active) continue;
      const acted = actedByAdset.get(row.adsetId);
      if (row.tier === "crown") {
        if (!acted?.hasScaleUp) {
          biancaMisses += 1;
          findings.push(makeBiancaCrownFinding(group, row));
        }
      } else if (row.tier === "dud") {
        if (!acted?.hasPause) {
          biancaMisses += 1;
          findings.push(makeBiancaKillFinding(group, row));
        }
      }
    }
  }

  // ── 2. Dahlia bin depth + seeded angles per hero product ───────────────────
  const heroProductIds = [
    ...new Set(results.products.map((g) => g.productId).filter((id): id is string => !!id)),
  ];
  for (const productId of heroProductIds) {
    const group = results.products.find((g) => g.productId === productId);
    if (!group) continue;
    const { readyToTest } = await listReadyToTest(admin, { workspaceId, productId });
    const depth = readyToTest.length;
    if (depth < DEFAULT_BIN_FLOOR) {
      dahliaGaps += 1;
      findings.push(makeDahliaBinFinding(group, depth));
    }
    const angles = await getProvenCompetitorAngles(admin, workspaceId, { productId, minDaysRunning: 30, limit: 8 })
      .catch(() => []);
    if (angles.length === 0) {
      dahliaGaps += 1;
      findings.push(makeDahliaSeedingFinding(group));
    }
  }

  // ── 3. Live-ad LF8 QA — headline + primary text + destination match ────────
  for (const group of results.products) {
    for (const row of group.rows) {
      if (!row.active) continue;
      if (!row.creative) continue;
      const copy = joinCopy(row.creative.headline, row.creative.primaryText, row.creative.description);
      if (copy && !hasAnyLf8(copy)) {
        liveAdIssues += 1;
        findings.push(makeLiveAdLf8Finding(group, row, copy));
      }
      const destination = row.creative.link ?? null;
      if (destination && !destinationMatchesProduct(destination, group.productTitle)) {
        liveAdIssues += 1;
        findings.push(makeLiveAdDestinationFinding(group, row, destination));
      }
    }
  }

  // ── 4. Author fix-specs (deduped) ──────────────────────────────────────────
  const authoredSlugs: string[] = [];
  const dedupedSlugs: string[] = [];
  for (const finding of findings) {
    const slug = fixSpecSlug(workspaceId, finding);
    // Dedup against getSpec (any status — a still-active fix-spec for the same finding covers it).
    // getSpec returns null for a brand-new slug — that's the go signal.
    const existing = await getSpec(workspaceId, slug).catch(() => null);
    if (existing) {
      dedupedSlugs.push(slug);
      continue;
    }
    // Dedup against an open `repair` job on the same slug (a parked repair covers the finding).
    if (await hasOpenRepairJob(admin, workspaceId, slug)) {
      dedupedSlugs.push(slug);
      continue;
    }
    const ok = await authorSpecRowStructured(
      workspaceId,
      slug,
      {
        title: `Ads supervisor: ${finding.summary}`,
        summary: null,
        owner: GROWTH_FUNCTION,
        parent: STATIC_AD_OPTIMIZATION_PARENT_PROSE,
        why: finding.why,
        what: finding.what,
        autoBuild: false,
        phases: [
          {
            title: "Phase 1 — apply the supervisor's fix",
            body: finding.body,
            verification: finding.verification,
            why: finding.why,
            what: finding.what,
            checks: defaultAdsSupervisorFixPhaseChecks(),
          },
        ],
      },
      "planned",
      {
        intendedStatusSetBy: "ads-supervisor",
        parentKind: "mandate",
        parentRef: STATIC_AD_OPTIMIZATION_MANDATE_REF,
      },
    ).catch((e) => {
      console.warn(`[ads-supervisor] authorSpecRowStructured threw for ${slug}: ${e instanceof Error ? e.message : e}`);
      return false;
    });
    if (ok) authoredSlugs.push(slug);
  }

  const evaluated = {
    products: results.products.length,
    tests: testCount,
    biancaMisses,
    dahliaGaps,
    liveAdIssues,
  };

  const result: AdsSupervisorResult = {
    evaluated,
    findings,
    authoredSlugs,
    dedupedSlugs,
  };

  // ── 5. Deliver the digest (no-op suppressed) ──────────────────────────────
  result.digest = await deliverAdsSupervisorDigest(admin, workspaceId, result);
  return result;
}

// ── Iteration-actions read (Bianca-acted check) ────────────────────────────────

/** For each adsetId, did Bianca write an `iteration_actions` row that would satisfy the pass's
 * "acted" bar? `hasScaleUp` proves a promote; `hasPause` proves a kill. Both status buckets count
 * (`decided` + `executed`) so a queued-but-unfired action still counts as covered. */
async function readIterationActionsForAdsets(
  admin: Admin,
  workspaceId: string,
  adsetIds: string[],
): Promise<Map<string, { hasScaleUp: boolean; hasPause: boolean }>> {
  const out = new Map<string, { hasScaleUp: boolean; hasPause: boolean }>();
  if (!adsetIds.length) return out;
  const { data, error } = await admin
    .from("iteration_actions")
    .select("object_id, action_type, status")
    .eq("workspace_id", workspaceId)
    .in("object_id", adsetIds)
    .in("action_type", ["scale_up", "pause"]);
  if (error) {
    console.warn(`[ads-supervisor] iteration_actions read failed: ${error.message}`);
    return out;
  }
  for (const row of (data ?? []) as Array<{ object_id: string; action_type: string; status: string | null }>) {
    const cur = out.get(row.object_id) ?? { hasScaleUp: false, hasPause: false };
    if (row.action_type === "scale_up") cur.hasScaleUp = true;
    if (row.action_type === "pause") cur.hasPause = true;
    out.set(row.object_id, cur);
  }
  return out;
}

/** Any not-yet-terminal `repair` box job for the given slug covers a fix-spec finding (a parked
 * repair job is already the "fix this" ledger). Best-effort — a read failure DOES NOT skip authoring. */
async function hasOpenRepairJob(admin: Admin, workspaceId: string, slug: string): Promise<boolean> {
  const { data, error } = await admin
    .from("agent_jobs")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .eq("kind", "repair")
    .eq("spec_slug", slug);
  if (error) {
    console.warn(`[ads-supervisor] agent_jobs read failed for ${slug}: ${error.message}`);
    return false;
  }
  const ACTIVE_STATUSES = new Set(["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume", "blocked_on_usage"]);
  return ((data ?? []) as Array<{ status: string }>).some((r) => ACTIVE_STATUSES.has(r.status));
}

// ── Finding constructors ───────────────────────────────────────────────────────

function makeBiancaCrownFinding(group: ProductTestGroup, row: TestAdsetRow): Finding {
  const id = `bianca-crown-${row.adsetId}`;
  const summary = `${group.productTitle} — Bianca missed a crown on ${row.adsetName}`;
  return {
    id,
    kind: "bianca_missed_crown",
    productId: row.productId,
    productTitle: group.productTitle,
    summary,
    why: `Test ${row.adsetName} crossed the crown bar (${row.purchases} purchases, CAC ${dollars(row.cacCents)}, spend ${dollars(row.spendCents)}) but the media-buyer's iteration_actions ledger carries no scale_up for this adset — Bianca skipped the promote.`,
    what: `Investigate why the media-buyer skipped the promote (dormant policy / sensor-trust gate / shadow-mode) and, if the gate is legitimate, tighten the promote path so the same-tick crown is never missed silently.`,
    body: `The ads-supervisor's every-3h pass classified adset ${row.adsetId} (${row.adsetName}) in product ${group.productTitle} as a crown per iteration_policies (${row.purchases} purchases, CAC ${dollars(row.cacCents)}, spend ${dollars(row.spendCents)}), but no iteration_actions row exists for this adset with action_type='scale_up' — Bianca did not promote it.\n\nCauses to rule out, in order:\n1) The workspace has no active iteration_policies row (dormant pass — expected).\n2) The media_buyer_sensor_trust snapshot is NOT green (Bianca deferred correctly).\n3) A shadow-mode policy classified the promote as a shadow write with no iteration_actions insert.\n4) A real skip class — the promote path evaluated the row but no-op'd (a bug).\n\nFor each, either document the expected no-action and tighten the pass, OR fix the promote code path so the crown lands as an iteration_actions row on the next media-buyer tick.`,
    verification: `- iteration_actions carries a row for adset ${row.adsetId} with action_type='scale_up' after the next media-buyer cadence tick, OR\n- the media_buyer_iteration_policy / sensor_trust snapshot is documented as legitimately dormant\n- \`npx tsc --noEmit\` passes`,
  };
}

function makeBiancaKillFinding(group: ProductTestGroup, row: TestAdsetRow): Finding {
  const id = `bianca-kill-${row.adsetId}`;
  const summary = `${group.productTitle} — Bianca missed a kill on ${row.adsetName}`;
  return {
    id,
    kind: "bianca_missed_kill",
    productId: row.productId,
    productTitle: group.productTitle,
    summary,
    why: `Test ${row.adsetName} crossed the kill bar (spend ${dollars(row.spendCents)}, purchases ${row.purchases}) but iteration_actions carries no pause for this adset — Bianca did not kill it.`,
    what: `Investigate why the media-buyer skipped the pause and, if the gate is legitimate, tighten the pause path so the same-tick dud never keeps burning spend silently.`,
    body: `The ads-supervisor's every-3h pass classified adset ${row.adsetId} (${row.adsetName}) in product ${group.productTitle} as a dud per iteration_policies (spend ${dollars(row.spendCents)}, purchases ${row.purchases}), but no iteration_actions row exists for this adset with action_type='pause' — Bianca did not kill it.\n\nSame root-cause tree as the missed-crown fix: dormant policy / sensor-trust denied / shadow-mode / a real skip bug. Document or fix.`,
    verification: `- iteration_actions carries a row for adset ${row.adsetId} with action_type='pause' after the next media-buyer cadence tick, OR\n- the dormant/shadow path is documented\n- \`npx tsc --noEmit\` passes`,
  };
}

function makeDahliaBinFinding(group: ProductTestGroup, depth: number): Finding {
  const id = `dahlia-bin-${group.productId ?? "workspace"}`;
  const summary = `${group.productTitle} — Dahlia's ready-to-test bin is thin (${depth}/${DEFAULT_BIN_FLOOR})`;
  return {
    id,
    kind: "dahlia_bin_below_floor",
    productId: group.productId,
    productTitle: group.productTitle,
    summary,
    why: `${group.productTitle} has only ${depth} ready-to-test creative(s) — below the DEFAULT_BIN_FLOOR of ${DEFAULT_BIN_FLOOR}. Bianca's replenish will starve within a cadence.`,
    what: `Stock the product's ready-to-test bin back to the floor. If ad-creative-cadence is dispatching for this product, tighten the pass; else diagnose the intelligence gap (product_ad_angles / product_intelligence) that's blocking Dahlia's generate step.`,
    body: `The ads-supervisor's every-3h pass ran listReadyToTest for product ${group.productTitle} and found depth=${depth} vs floor=${DEFAULT_BIN_FLOOR}. Either the ad-creative-cadence cron isn't enqueueing for this product OR Dahlia's runAdCreativeJob is failing before the ad_campaigns insert. Diagnose which (agent_jobs kind='ad-creative' history + product_ad_angles presence for the product) and fix the smaller failure.`,
    verification: `- listReadyToTest({productId=${group.productId ?? "null"}}) depth ≥ ${DEFAULT_BIN_FLOOR} after the next ad-creative-cadence tick, OR the missing product_ad_angles are surfaced as an authored intelligence-fill spec\n- \`npx tsc --noEmit\` passes`,
  };
}

function makeDahliaSeedingFinding(group: ProductTestGroup): Finding {
  const id = `dahlia-seeding-${group.productId ?? "workspace"}`;
  const summary = `${group.productTitle} — no proven competitor angles seeded`;
  return {
    id,
    kind: "dahlia_zero_seeded_angles",
    productId: group.productId,
    productTitle: group.productTitle,
    summary,
    why: `${group.productTitle} has zero rows in the creative-skeletons library with days_running ≥ 30 — Dahlia has no proven competitor angles to seed her generates from.`,
    what: `Fill the product's competitor-angle shelf. Ensure the creative-scout has scouted this product's chosen competitors, and that days_running has settled (a fresh scout row lands at 0 until the batch analyzer stamps a day count).`,
    body: `The ads-supervisor's every-3h pass called getProvenCompetitorAngles({productId=${group.productId ?? "null"}, minDaysRunning: 30}) and got 0 rows. Dahlia's generator ranks angles by longevity; with an empty shelf her briefs default to the workspace-wide niche pool (broader + weaker). Prime the shelf by scouting the product's competitors + running the analyzer.`,
    verification: `- getProvenCompetitorAngles({productId=${group.productId ?? "null"}, minDaysRunning: 30, limit: 6}) returns ≥ 4 rows\n- \`npx tsc --noEmit\` passes`,
  };
}

function makeLiveAdLf8Finding(group: ProductTestGroup, row: TestAdsetRow, copy: string): Finding {
  const id = `live-ad-lf8-${row.adsetId}`;
  const summary = `${group.productTitle} — live test ad has no LF8 language`;
  return {
    id,
    kind: "live_ad_lf8_thin",
    productId: row.productId,
    productTitle: group.productTitle,
    summary,
    why: `The live creative on adset ${row.adsetName} has no Life-Force-8 language in its headline / primary text. LF8-thin copy consistently underperforms on cost-per-add-to-cart in our historical cohort.`,
    what: `Rewrite the ad copy to lead with at least one LF8-adjacent benefit (energy, sleep, focus, protect, family, proven, unlock, boost, calm, …) — the differentiated acquisition angle, not the retention truth.`,
    body: `Adset ${row.adsetId} (${row.adsetName}) in product ${group.productTitle} is running with copy that carries none of the LF8 keyword set. Copy scanned: ${copy.slice(0, 240)}\n\nRewrite via Dahlia's next generate (edit the creative_brief lead) or via a direct copy-edit spec. Either way the next generate for this cohort should carry LF8 language on line 1.`,
    verification: `- the next ad_campaigns row for product ${group.productTitle} carries a headline / primary_text containing ≥ 1 LF8-adjacent term\n- \`npx tsc --noEmit\` passes`,
  };
}

function makeLiveAdDestinationFinding(group: ProductTestGroup, row: TestAdsetRow, destination: string): Finding {
  const id = `live-ad-dest-${row.adsetId}`;
  const summary = `${group.productTitle} — live test ad destination doesn't match the product`;
  return {
    id,
    kind: "live_ad_destination_mismatch",
    productId: row.productId,
    productTitle: group.productTitle,
    summary,
    why: `The live creative on adset ${row.adsetName} points at a URL whose path does not carry the product handle — the scent-match invariant (paid traffic lands on the PDP it's testing) is broken.`,
    what: `Fix the destination on the ad_campaigns row for this cohort so the URL resolves to the product's PDP (or the intended scent-matched lander). A wrong destination breaks conversion.`,
    body: `Adset ${row.adsetId} (${row.adsetName}) for product ${group.productTitle} is pointing at ${destination}. The expected destination is a URL whose lowercased path segment contains the product's kebab-cased title. Either (a) the ad_campaigns.landing_url column was set wrong at publish, OR (b) the product was re-slugged and the destination didn't follow. Investigate the ad_publish_jobs run for this campaign and fix the landing_url.`,
    verification: `- ad_campaigns.landing_url for the cohort's active campaign matches the product's PDP handle (path contains the kebab-cased product title)\n- \`npx tsc --noEmit\` passes`,
  };
}

// ── Fix-spec plumbing ──────────────────────────────────────────────────────────

/** Deterministic slug per finding — keyed by workspace + kind + target id so a re-run of the pass
 * on the same drift class produces the SAME slug (and `getSpec`-based dedup kicks in). */
function fixSpecSlug(workspaceId: string, finding: Finding): string {
  return `${FIX_SPEC_SLUG_PREFIX}${workspaceId.slice(0, 8)}-${finding.id}`;
}

/**
 * The default machine check every ads-supervisor-authored fix-phase carries so the author-chokepoint
 * gate `assertEveryPhaseHasMachineCheck` cannot reject the write. Same shape mario's
 * `defaultMarioFixPhaseChecks` + the markdown author path use — a bare `tsc` gate is the safe
 * default for a fix landing on main. The prose verification rides verbatim on the phase's
 * `verification` column (human-facing); the tsc check is what the deterministic runner executes.
 *
 * Never `needs_human` — the spec explicitly forbids that ("machine checks only — NEVER needs_human").
 */
function defaultAdsSupervisorFixPhaseChecks(): SpecPhaseCheckInput[] {
  return [
    {
      position: 1,
      description: "Repo typechecks clean (`npx tsc --noEmit`) after this phase lands.",
      kind: "auto",
      exec_kind: "tsc",
      params: null,
    },
  ];
}

// ── Digest ────────────────────────────────────────────────────────────────────

/** Compose the growth-director-voice digest text from the pass's findings. Suppresses the no-op
 * (zero findings + zero authored slugs) so #director-growth-max isn't spammed every 3h. */
export function composeAdsSupervisorDigest(result: AdsSupervisorResult): { text: string; hasContent: boolean } {
  const { evaluated, findings, authoredSlugs, dedupedSlugs } = result;
  const hasContent = findings.length > 0 || authoredSlugs.length > 0;
  const total = evaluated.biancaMisses + evaluated.dahliaGaps + evaluated.liveAdIssues;
  if (!hasContent) {
    return {
      text: `🚀 Max (Growth) — ads-supervisor: nothing to report (${evaluated.tests} live test(s) across ${evaluated.products} product(s), all within policy).`,
      hasContent: false,
    };
  }
  const header = `🚀 Max (Growth) — ads-supervisor: ${total} drift issue(s) across ${evaluated.products} product(s). ${authoredSlugs.length} fix-spec(s) authored, ${dedupedSlugs.length} deduped.`;
  const findingLines = findings.slice(0, 12).map((f) => `• ${f.summary}`);
  const authoredLines = authoredSlugs.length
    ? [``, `Authored:`, ...authoredSlugs.slice(0, 12).map((s) => `• ${s}`)]
    : [];
  return {
    text: [header, ...findingLines, ...authoredLines].join("\n"),
    hasContent: true,
  };
}

/** Post the ads-supervisor digest to the founder's #director-growth-max channel. Skips when: no
 * channel configured, Slack not connected, or the pass had NO findings + NO authored slugs (the
 * no-op suppression). Best-effort — a Slack hiccup must not fail the pass. */
export async function deliverAdsSupervisorDigest(
  admin: Admin,
  workspaceId: string,
  result: AdsSupervisorResult,
): Promise<{ posted: boolean; reason?: string; ts?: string }> {
  const { hasContent, text } = composeAdsSupervisorDigest(result);
  if (!hasContent) return { posted: false, reason: "no findings + no authored slugs — no-op suppressed" };

  const { data: ws } = await admin
    .from("workspaces")
    .select("slack_growth_director_channel_id")
    .eq("id", workspaceId)
    .maybeSingle();
  const channel = (ws as { slack_growth_director_channel_id: string | null } | null)?.slack_growth_director_channel_id;
  if (!channel) return { posted: false, reason: "no slack_growth_director_channel_id configured" };

  const token = await getSlackToken(workspaceId);
  if (!token) return { posted: false, reason: "slack not connected" };

  const post = await postAsGrowthDirector(token, channel, [], text);
  if (!post.ok) return { posted: false, reason: "postAsGrowthDirector failed" };

  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: GROWTH_FUNCTION,
    actionKind: "ads_supervisor_digest_posted",
    specSlug: "growth-ads-supervisor-3h-agent",
    reason: "posted ads-supervisor pass digest to #director-growth-max",
    metadata: {
      channel,
      message_ts: post.ts ?? null,
      findings: result.findings.length,
      authored: result.authoredSlugs.length,
      deduped: result.dedupedSlugs.length,
      autonomous: true,
    },
  });
  return { posted: true, ts: post.ts };
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function joinCopy(...parts: Array<string | null | undefined>): string {
  return parts.filter((s): s is string => !!s && s.trim().length > 0).join(" \n ").toLowerCase();
}

/** Any Life-Force-8 keyword hit (substring match, lowercase-normalized). Cheap + deterministic. */
export function hasAnyLf8(copyLower: string): boolean {
  for (const kw of LF8_KEYWORDS) if (copyLower.includes(kw)) return true;
  return false;
}

/** Loose scent-match: does the destination URL's PATH contain a kebab-cased fragment of the product
 * title? Bare-hostname URLs (homepage-only) always fail — a paid test must land on a PDP. */
export function destinationMatchesProduct(destination: string, productTitle: string): boolean {
  let path = "";
  try {
    const u = new URL(destination);
    path = (u.pathname || "").toLowerCase();
  } catch {
    // Bad URL — treat as a mismatch (the pass never suppresses a real destination bug on a parse error).
    return false;
  }
  if (!path || path === "/") return false;
  const tokens = productTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter((t) => t.length >= 4); // "the", "and", … won't scent-match anything
  if (tokens.length === 0) return true; // no strong tokens to check — don't false-flag
  return tokens.some((t) => path.includes(t));
}

function dollars(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
