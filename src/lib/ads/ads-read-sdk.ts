/**
 * ads-read-sdk — the READ chokepoint for ad campaigns, angles, provenance, crowned winners, and
 * "how was this ad actually made" traces. Exists because hand-rolled `.from("ad_campaigns")` /
 * `.from("product_ad_angles")` probes kept producing WRONG conclusions (an `ilike` on a uuid column
 * silently returns zero rows; a raw select of a non-existent column reads as empty). Per the
 * repo-wide rule "Raw `.from(...)` with no SDK → STOP", every read-side answer about an ad, its angle,
 * its explore/exploit provenance, or its execution path goes through here — typed, column-correct,
 * and composed from the SAME canonical helpers the dashboard's `/api/ads/campaigns/[id]` route uses
 * (`readLatestCopyQaVerdict`, `readPostabilityOverride`, `readCopyVariants`, `isPostable`).
 *
 * WRITE compliance is unchanged: writes still go through `insertReadyCreative` / the media-buyer SDK.
 * This module is read-only — it never mutates.
 *
 * Two derivations are the whole point of the SDK (both were the source of the wrong hand-probe reads):
 *   1. badge vs true intent — `provenance.mode` is `isCompetitor ? "explore" : "exploit"` (a SOURCE
 *      label), NOT the crown-gated slot intent. So an own-brand angle is badged "exploit" on the
 *      detail page even with ZERO crowned winners. `deriveExploreExploit` returns BOTH the stored
 *      badge AND the true crown-gated intent, plus a `mislabeledExploit` flag.
 *   2. execution path — `author_self_score != null` ⇒ the Dahlia/Max author box session produced the
 *      copy; both `author_self_score` null AND no Max copy-QC verdict ⇒ the deterministic
 *      `buildMetaCopyPack` node path (no session, no LF8/Schwartz treatments, no Max gate).
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { angleKey } from "@/lib/ads/creative-learning";
import type { AngleProvenance, AuthorSelfScore } from "@/lib/ads/creative-agent";
import { readLatestCopyQaVerdict, type StoredCopyQaVerdict } from "@/lib/ads/creative-qa";
import { readPostabilityOverride, type PostabilityOverride } from "@/lib/ads/postability-override";
import { readCopyVariants } from "@/lib/ads/ad-copy-variants";
import { isPostable } from "@/lib/media-buyer/publish-gate";

type Admin = ReturnType<typeof createAdminClient>;

/** The seven angle sources (mirrors `ScoredAngle["source"]`). `competitor` is the only EXPLORE
 *  source; every other value is an own-brand asset the provenance labels "exploit". */
export type AngleSource =
  | "ad_angle" | "review_cluster" | "transformation" | "benefit" | "ingredient" | "authority" | "competitor";
export type ExploreExploit = "explore" | "exploit";

export interface CopyPack {
  headlines?: string[];
  primaryTexts?: string[];
  description?: string;
  /** The persuasion frameworks the 5-variant pack was authored across (lf8 / schwartz / cialdini /
   *  hopkins / sugarman). EMPTY on the deterministic path — a fast "did the treatments run?" signal. */
  frameworks?: string[];
}

export interface AngleRow {
  id: string;
  workspaceId: string;
  productId: string;
  /** From `metadata.provenance.source` — angles do not store `source` as a scalar column. */
  source: AngleSource | null;
  hookSlug: string | null;
  hookOneLiner: string | null;
  leadBenefitAnchor: string | null;
  metaHeadline: string | null;
  metaPrimaryText: string | null;
  metaDescription: string | null;
  isActive: boolean;
  generatedBy: string | null;
  createdAt: string | null;
  provenance: AngleProvenance | null;
  copyPack: CopyPack | null;
  /** Number of headline variations on the pack (0 = deterministic single-caption / missing pack). */
  variantCount: number;
  /** The persuasion frameworks the pack ran across (empty = no LF8/Schwartz treatments applied). */
  copyFrameworks: string[];
}

/** How the explore/exploit story resolves for one ad — the badge the dashboard shows vs the true,
 *  crown-gated intent. `mislabeledExploit` is the exact defect: an own-brand angle badged "exploit"
 *  while its concept has NO crowned winner (so it is really an explore). */
export interface ExploreExploitVerdict {
  /** The stored badge = `provenance.mode` = `isCompetitor ? "explore" : "exploit"`. */
  badgeMode: ExploreExploit | null;
  /** The TRUE intent: `exploit` only if this angle's concept has ≥1 crowned winner; else `explore`. */
  trueIntent: ExploreExploit;
  /** The concept has a crowned/reactivated test outcome backing an exploit. */
  hasCrownForConcept: boolean;
  /** Badge says exploit but there is no crown → it is really an own-brand explore, mislabeled. */
  mislabeledExploit: boolean;
}

/** Which code path produced the creative's COPY. */
export type ExecutionPath = "author-box-session" | "deterministic-node";

export interface AdSummary {
  id: string;
  workspaceId: string;
  productId: string | null;
  name: string | null;
  status: string | null;
  conceptTag: string | null;
  audienceTemperature: "cold" | "warm" | "hot" | null;
  /** Dahlia's per-framework self-score (JSONB) — PRESENT ⇒ the author box session wrote the copy;
   *  NULL ⇒ the deterministic node path. See {@link deriveExecutionPath}. */
  authorSelfScore: AuthorSelfScore | null;
  maxQcEligible: boolean | null;
  angleId: string | null;
  createdAt: string | null;
}

export interface AdFull extends AdSummary {
  productTitle: string | null;
  angle: AngleRow | null;
  maxCopyVerdict: StoredCopyQaVerdict | null;
  postabilityOverride: PostabilityOverride | null;
  copyVariantCount: number;
  /** Did Max's copy-QC actually grade this ad? (false = "Awaiting Max's copy-QC" on the UI). */
  maxGraded: boolean;
  /** The composite Bianca postability predicate: (Max hard_gate AND score≥9) OR CEO override. */
  postable: boolean;
  /** Which engine wrote the copy. */
  executionPath: ExecutionPath;
  exploreExploit: ExploreExploitVerdict;
}

export interface CrownedWinner {
  productId: string;
  angleKey: string;
  treatment: string | null;
  outcome: "won" | "reactivated";
  createdAt: string | null;
}

export interface ProductAngleInventory {
  productId: string;
  competitorAngles: number;
  ownBrandAngles: number;
  /** own-brand angle count broken out by source (review_cluster / transformation / benefit / …). */
  ownBySource: Record<string, number>;
  hasCompetitorAngles: boolean;
  /** scouted competitor ad skeletons in the library, by advertiser — the imitation raw material. */
  skeletonTotal: number;
  skeletonsByAdvertiser: Record<string, number>;
  crownedWinners: CrownedWinner[];
  /** With 0 crowns, EVERY slot should be explore — this is the health line the founder asked for. */
  expectedExploitSlots: 0 | "up-to-half";
}

export interface AdOriginTrace {
  ad: AdFull;
  /** Best-effort link to the agent_job that produced this ad (matched by kind + product + time). */
  producingJob: { id: string; kind: string; status: string | null; specSlug: string | null; createdAt: string | null } | null;
  executionPath: ExecutionPath;
  maxGraded: boolean;
  usedPersuasionTreatments: boolean;
  exploreExploit: ExploreExploitVerdict;
  /** Plain-English one-liner: what made it, whether it skipped the box session / Max / treatments. */
  summary: string;
}

// ── pure derivations (exported for unit tests, no DB) ────────────────────────────────────────────

/** The badge the UI renders vs the true crown-gated intent. `crownedConcepts` is the set of
 *  `angleKey`s that have a won/reactivated outcome for this product. */
export function deriveExploreExploit(
  angle: Pick<AngleRow, "source" | "provenance" | "hookOneLiner" | "metaHeadline" | "leadBenefitAnchor"> | null,
  crownedConcepts: Set<string>,
): ExploreExploitVerdict {
  const badgeMode = angle?.provenance?.mode ?? null;
  const conceptSeed =
    angle?.provenance?.lead_benefit || angle?.leadBenefitAnchor || angle?.hookOneLiner || angle?.metaHeadline || "";
  const hasCrownForConcept = conceptSeed.length > 0 && crownedConcepts.has(angleKey(conceptSeed));
  const trueIntent: ExploreExploit = hasCrownForConcept ? "exploit" : "explore";
  return {
    badgeMode,
    trueIntent,
    hasCrownForConcept,
    mislabeledExploit: badgeMode === "exploit" && !hasCrownForConcept,
  };
}

/** author box session iff Dahlia stamped a self-score (a JSONB object); otherwise the deterministic
 *  node path. Any non-null self-score object counts — the box session always writes one. */
export function deriveExecutionPath(authorSelfScore: AuthorSelfScore | null): ExecutionPath {
  return authorSelfScore != null ? "author-box-session" : "deterministic-node";
}

// ── internal row → typed mappers ─────────────────────────────────────────────────────────────────

function mapAngle(row: Record<string, unknown> | null): AngleRow | null {
  if (!row) return null;
  const meta = (row.metadata as Record<string, unknown> | null) ?? null;
  const provenance = (meta?.provenance as AngleProvenance | null) ?? null;
  const copyPack = (meta?.copy_pack as CopyPack | null) ?? null;
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    productId: row.product_id as string,
    source: (provenance?.source as AngleSource | null) ?? null,
    hookSlug: (row.hook_slug as string | null) ?? null,
    hookOneLiner: (row.hook_one_liner as string | null) ?? null,
    leadBenefitAnchor: (row.lead_benefit_anchor as string | null) ?? null,
    metaHeadline: (row.meta_headline as string | null) ?? null,
    metaPrimaryText: (row.meta_primary_text as string | null) ?? null,
    metaDescription: (row.meta_description as string | null) ?? null,
    isActive: (row.is_active as boolean | null) ?? false,
    generatedBy: (row.generated_by as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
    provenance,
    copyPack,
    variantCount: Array.isArray(copyPack?.headlines) ? copyPack!.headlines!.length : 0,
    copyFrameworks: Array.isArray(copyPack?.frameworks) ? (copyPack!.frameworks as string[]) : [],
  };
}

const AD_SELECT =
  "id, workspace_id, product_id, name, status, concept_tag, audience_temperature, author_self_score, max_qc_eligible, angle_id, created_at";
const ANGLE_SELECT =
  "id, workspace_id, product_id, hook_slug, hook_one_liner, lead_benefit_anchor, meta_headline, meta_primary_text, meta_description, is_active, generated_by, created_at, metadata";

function mapSummary(row: Record<string, unknown>): AdSummary {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    productId: (row.product_id as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    conceptTag: (row.concept_tag as string | null) ?? null,
    audienceTemperature: (row.audience_temperature as AdSummary["audienceTemperature"]) ?? null,
    authorSelfScore: (row.author_self_score as AuthorSelfScore | null) ?? null,
    maxQcEligible: (row.max_qc_eligible as boolean | null) ?? null,
    angleId: (row.angle_id as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
  };
}

// ── public read surface ──────────────────────────────────────────────────────────────────────────

/** The set of crowned/reactivated concept keys for a product — the ONLY thing that legitimately makes
 *  an exploit slot. Empty set ⇒ every slot must be explore. */
export async function getCrownedWinners(
  admin: Admin,
  opts: { workspaceId: string; productId?: string },
): Promise<CrownedWinner[]> {
  let q = admin
    .from("creative_test_outcomes")
    .select("product_id, angle_key, treatment, outcome, created_at")
    .eq("workspace_id", opts.workspaceId)
    .in("outcome", ["won", "reactivated"]);
  if (opts.productId) q = q.eq("product_id", opts.productId);
  const { data, error } = await q;
  if (error) throw new Error(`getCrownedWinners: ${error.message}`);
  return (data ?? []).map((r) => ({
    productId: r.product_id as string,
    angleKey: r.angle_key as string,
    treatment: (r.treatment as string | null) ?? null,
    outcome: r.outcome as "won" | "reactivated",
    createdAt: (r.created_at as string | null) ?? null,
  }));
}

export async function getAngle(
  admin: Admin,
  opts: { workspaceId: string; angleId: string },
): Promise<AngleRow | null> {
  const { data, error } = await admin
    .from("product_ad_angles")
    .select(ANGLE_SELECT)
    .eq("id", opts.angleId)
    .eq("workspace_id", opts.workspaceId)
    .maybeSingle();
  if (error) throw new Error(`getAngle: ${error.message}`);
  return mapAngle(data as Record<string, unknown> | null);
}

export async function listProductAngles(
  admin: Admin,
  opts: { workspaceId: string; productId: string; source?: AngleSource; activeOnly?: boolean },
): Promise<AngleRow[]> {
  let q = admin
    .from("product_ad_angles")
    .select(ANGLE_SELECT)
    .eq("workspace_id", opts.workspaceId)
    .eq("product_id", opts.productId)
    .order("created_at", { ascending: false });
  if (opts.activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q;
  if (error) throw new Error(`listProductAngles: ${error.message}`);
  let rows = (data ?? []).map((r) => mapAngle(r as Record<string, unknown>)!).filter(Boolean);
  if (opts.source) rows = rows.filter((r) => r.source === opts.source);
  return rows;
}

export async function listAds(
  admin: Admin,
  opts: { workspaceId: string; productId?: string; status?: string; since?: string; limit?: number },
): Promise<AdSummary[]> {
  let q = admin
    .from("ad_campaigns")
    .select(AD_SELECT)
    .eq("workspace_id", opts.workspaceId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 25);
  if (opts.productId) q = q.eq("product_id", opts.productId);
  if (opts.status) q = q.eq("status", opts.status);
  if (opts.since) q = q.gte("created_at", opts.since);
  const { data, error } = await q;
  if (error) throw new Error(`listAds: ${error.message}`);
  return (data ?? []).map((r) => mapSummary(r as Record<string, unknown>));
}

/** The canonical single-ad read — mirrors the dashboard's `/api/ads/campaigns/[id]` composition, plus
 *  the two derivations (execution path, explore/exploit badge-vs-truth). */
export async function getAd(
  admin: Admin,
  opts: { workspaceId: string; campaignId: string },
): Promise<AdFull | null> {
  const { data: c, error } = await admin
    .from("ad_campaigns")
    .select(`${AD_SELECT}, products(title)`)
    .eq("id", opts.campaignId)
    .eq("workspace_id", opts.workspaceId)
    .maybeSingle();
  if (error) throw new Error(`getAd: ${error.message}`);
  if (!c) return null;
  const row = c as Record<string, unknown>;
  const summary = mapSummary(row);
  const productTitle = ((row.products as { title?: string } | null)?.title as string | null) ?? null;

  const angle = summary.angleId ? await getAngle(admin, { workspaceId: opts.workspaceId, angleId: summary.angleId }) : null;
  const maxCopyVerdict = await readLatestCopyQaVerdict(admin, {
    workspaceId: opts.workspaceId,
    adCampaignId: opts.campaignId,
  }).catch(() => null);
  const postabilityOverride = await readPostabilityOverride(admin, {
    workspaceId: opts.workspaceId,
    adCampaignId: opts.campaignId,
  }).catch(() => null);
  const copyVariants = await readCopyVariants(admin, opts.campaignId).catch(() => []);

  const crowned = summary.productId
    ? new Set((await getCrownedWinners(admin, { workspaceId: opts.workspaceId, productId: summary.productId })).map((w) => w.angleKey))
    : new Set<string>();

  return {
    ...summary,
    productTitle,
    angle,
    maxCopyVerdict,
    postabilityOverride,
    copyVariantCount: copyVariants.length,
    maxGraded: maxCopyVerdict != null,
    postable: isPostable(maxCopyVerdict, postabilityOverride),
    executionPath: deriveExecutionPath(summary.authorSelfScore),
    exploreExploit: deriveExploreExploit(angle, crowned),
  };
}

export async function getProductAngleInventory(
  admin: Admin,
  opts: { workspaceId: string; productId: string },
): Promise<ProductAngleInventory> {
  const angles = await listProductAngles(admin, { workspaceId: opts.workspaceId, productId: opts.productId });
  const competitorAngles = angles.filter((a) => a.source === "competitor").length;
  const ownAngles = angles.filter((a) => a.source && a.source !== "competitor");
  const ownBySource: Record<string, number> = {};
  for (const a of ownAngles) ownBySource[a.source as string] = (ownBySource[a.source as string] ?? 0) + 1;

  const { data: sk, error: skErr } = await admin
    .from("creative_skeletons")
    .select("advertiser")
    .eq("workspace_id", opts.workspaceId)
    .eq("product_id", opts.productId);
  if (skErr) throw new Error(`getProductAngleInventory(skeletons): ${skErr.message}`);
  const skeletonsByAdvertiser: Record<string, number> = {};
  for (const s of sk ?? []) {
    const adv = ((s as { advertiser?: string }).advertiser as string | null) ?? "unknown";
    skeletonsByAdvertiser[adv] = (skeletonsByAdvertiser[adv] ?? 0) + 1;
  }

  const crownedWinners = await getCrownedWinners(admin, { workspaceId: opts.workspaceId, productId: opts.productId });

  return {
    productId: opts.productId,
    competitorAngles,
    ownBrandAngles: ownAngles.length,
    ownBySource,
    hasCompetitorAngles: competitorAngles > 0,
    skeletonTotal: (sk ?? []).length,
    skeletonsByAdvertiser,
    crownedWinners,
    expectedExploitSlots: crownedWinners.length === 0 ? 0 : "up-to-half",
  };
}

/** "How was this ad made?" — the diagnostic the founder asked for. Classifies the execution path
 *  (author box session vs deterministic node), whether Max graded it, whether the LF8/Schwartz/etc
 *  persuasion treatments ran, and the explore/exploit badge-vs-truth — then narrates it. */
export async function traceAdOrigin(
  admin: Admin,
  opts: { workspaceId: string; campaignId: string },
): Promise<AdOriginTrace | null> {
  const ad = await getAd(admin, opts);
  if (!ad) return null;

  // Best-effort link to the producing agent_job: the most recent ad-creative(-copy-author) job for
  // this product created at or before the campaign row.
  let producingJob: AdOriginTrace["producingJob"] = null;
  if (ad.productId && ad.createdAt) {
    const { data: jobs } = await admin
      .from("agent_jobs")
      .select("id, kind, status, spec_slug, instructions, created_at")
      .eq("workspace_id", opts.workspaceId)
      .in("kind", ["ad-creative", "ad-creative-copy-author"])
      .lte("created_at", ad.createdAt)
      .order("created_at", { ascending: false })
      .limit(15);
    const match = (jobs ?? []).find((j) => {
      try {
        const inst = JSON.parse((j.instructions as string | null) ?? "{}") as { product_id?: string };
        return inst.product_id === ad.productId;
      } catch {
        return false;
      }
    });
    if (match)
      producingJob = {
        id: match.id as string,
        kind: match.kind as string,
        status: (match.status as string | null) ?? null,
        specSlug: (match.spec_slug as string | null) ?? null,
        createdAt: (match.created_at as string | null) ?? null,
      };
  }

  const usedPersuasionTreatments = (ad.angle?.copyFrameworks.length ?? 0) > 0;
  const parts: string[] = [];
  parts.push(
    ad.executionPath === "author-box-session"
      ? `Made by the Dahlia author box session (self-score total ${ad.authorSelfScore?.total ?? "?"}).`
      : `Made by the DETERMINISTIC node path (no Dahlia/Max box session — author_self_score is NULL).`,
  );
  parts.push(ad.maxGraded ? `Max copy-QC graded it (persuasion ${ad.maxCopyVerdict?.persuasion_score}/10).` : `Max copy-QC NEVER graded it.`);
  parts.push(
    usedPersuasionTreatments
      ? `Persuasion treatments ran: ${ad.angle?.copyFrameworks.join(", ")}.`
      : `NO LF8/Schwartz/etc persuasion treatments (copy_pack.frameworks empty).`,
  );
  parts.push(
    ad.exploreExploit.mislabeledExploit
      ? `Badged "EXPLOIT" but its concept has NO crowned winner → it is really an own-brand EXPLORE, mislabeled.`
      : `explore/exploit: badge=${ad.exploreExploit.badgeMode ?? "n/a"}, true=${ad.exploreExploit.trueIntent}.`,
  );

  return {
    ad,
    producingJob,
    executionPath: ad.executionPath,
    maxGraded: ad.maxGraded,
    usedPersuasionTreatments,
    exploreExploit: ad.exploreExploit,
    summary: parts.join(" "),
  };
}
