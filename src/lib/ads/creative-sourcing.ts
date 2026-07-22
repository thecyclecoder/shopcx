/**
 * creative-sourcing — the shared SDK for WHERE great ad ideas come from + HOW ads actually perform, so
 * the agents (Dahlia sources angles, Bianca reads signal) and Max (supervises) all call ONE surface
 * instead of re-deriving it from raw Meta/DB queries (CEO 2026-07-11). Three idea pools + one analyzer:
 *
 *   1. getProvenCompetitorAngles — the 276-strong [[../../tables/creative_skeletons]] library, RANKED by
 *      `days_running` (longevity = a competitor is profitably scaling it = a validated angle). e.g.
 *      "Meet Nature's Ozempic" (118d), "Nighttime BP Spikes GONE in 28 Days" (210d).
 *   2. getOurWinningAngles — our OWN best-performing ads, judged on the validated signals (low cost-per-ATC,
 *      low CPP) — "what works for US", the exploit seed.
 *   3. (web DR research — a future pool; stubbed as a TODO.)
 *
 *   analyzeAccountAds — the per-ad performance analyzer (spend, purchases, CPP, ATC, cost-per-ATC, CPM,
 *      CTR, reactions/saves/shares) validated on 99 historical ads: cost-per-ATC + CPM discriminate
 *      winners; CTR + engagement are TRAPS (losers click/react MORE). See [[meta-cpa-signal]] · [[creative-brief]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { getMetaUserToken } from "@/lib/meta-ads";
import { recordDirectorActivity } from "@/lib/director-activity";
import type { ConceptTags } from "@/lib/creative-skeleton";

// ── dahlia-researches-from-winners-flow-ad-library Phase 1 — declared-intent envelope ──────────
/** The intent Dahlia declares FIRST for every creative task — carried through the whole pipeline
 *  so research/angle-selection reads the winner library SCOPED to that intent (a cold-audience
 *  task prefers cold-appropriate winner concepts; a hot-audience task prefers most-aware ones).
 *  `purpose` names WHY the creative is being built ('test-to-find-winner' is today's only value;
 *  future retention / re-target purposes will land as new literals). */
export interface CreativeIntent {
  audience_temperature: "cold" | "warm" | "hot";
  purpose: "test-to-find-winner";
}

/** The Schwartz awareness stages a competitor WINNER concept targets that MATCH a declared
 *  audience temperature. Used by `getProvenCompetitorAngles` to partition (not filter) the pool
 *  when `intent` is present — temperature-matching winners rank first, off-temp winners fill the
 *  remaining slots (never starve the shelf). Cold reads a scroll-stopping stranger — a
 *  problem/unaware-stage ad; warm has heard of the category / brand; hot is ready-to-buy.  */
const AWARENESS_STAGES_BY_TEMPERATURE: Readonly<Record<CreativeIntent["audience_temperature"], readonly string[]>> = {
  cold: ["unaware", "problem_aware"],
  warm: ["solution_aware", "product_aware"],
  hot: ["most_aware"],
};

/** True iff a competitor angle's concept-tags awareness_stage matches the intended temperature. Pure
 *  + exported for the Phase 1 vitest so the mapping is greppable + pinned. A null awareness_stage
 *  (rows visioned before the concept_tags rubric shipped) matches nothing — those angles fall to the
 *  tail of the partition, not the temperature-matched head. */
export function awarenessStageMatchesTemperature(
  awarenessStage: string | null | undefined,
  temperature: CreativeIntent["audience_temperature"],
): boolean {
  if (!awarenessStage) return false;
  return AWARENESS_STAGES_BY_TEMPERATURE[temperature].includes(awarenessStage);
}

/** True iff a competitor ad's FOCAL POINT reads WARM/HOT (retargeting) rather than cold prospecting
 *  (CEO 2026-07-17; authority/mechanism un-excluded 2026-07-19). A cold audience is a scroll-stopping
 *  stranger — an ad whose focus is an OFFER, a CUSTOMER REVIEW, or URGENCY is almost certainly aimed
 *  at a warm/hot (already-aware) audience, so it's the wrong imitation base for a cold creative.
 *  Signals (any → true):
 *   - an OFFER is present (`angle.offer`) — a discount is the clearest warm/hot tell;
 *   - the Cialdini lever is `social_proof` (review-focal) or `scarcity` (offer/urgency);
 *   - the archetype / angle text names an offer / review / guarantee / comparison focus.
 *  NOTE — `authority` (credential/expert-backed: "clinically shown", "nutritionist-formulated") and
 *  MECHANISM ("how it actually works") are COLD-APPROPRIATE, NOT warm/hot: a stranger trusts
 *  credibility + education to open awareness. Excluding them emptied the cold shelf for products whose
 *  entire proven competitor set is authority-framed (Guru Focus: all 8 deeply-proven winners were
 *  `cialdini=authority` → 0 cold-eligible → own-brand fallback every run). The OFFER check (line
 *  below) still hard-excludes discount/retargeting ads, so the 2026-07-17 cold_offer_leak stays shut. */
export function competitorFocalIsWarmHot(angle: Pick<CompetitorAngle, "offer" | "conceptTags">): boolean {
  if (angle.offer && angle.offer.trim().length > 0) return true;
  const ct = angle.conceptTags ?? null;
  const lever = (ct?.cialdini_lever ?? "").toLowerCase();
  if (lever === "social_proof" || lever === "scarcity") return true;
  const text = `${ct?.archetype ?? ""} ${ct?.angle ?? ""}`.toLowerCase();
  return /offer|discount|deal|% ?off|sale|social.?proof|review|testimonial|guarantee|money.?back|risk.?free|us.?vs.?them|comparison/.test(text);
}

/** True iff a competitor ad's FOCAL POINT reads COLD/prospecting — curiosity or problem→solution, the
 *  awareness-opening angles a stranger responds to. Signals (any → true): a cold awareness_stage
 *  (unaware / problem_aware), or an archetype/angle naming curiosity / a problem-agitate / a story hook. */
export function competitorFocalIsCold(angle: Pick<CompetitorAngle, "conceptTags">): boolean {
  const ct = angle.conceptTags ?? null;
  if (awarenessStageMatchesTemperature(ct?.awareness_stage, "cold")) return true;
  const text = `${ct?.archetype ?? ""} ${ct?.angle ?? ""}`.toLowerCase();
  return /curiosity|question|myth|mistake|secret|problem|agitate|struggle|frustrat|founder.?story|story|before.?you|what.?if|did.?you.?know/.test(text);
}

/** How well a competitor ad fits as an imitation base for a target audience temperature:
 *   - `match`    — the ad's focal point is RIGHT for this temperature (cold ⇒ curiosity/problem, no
 *                  offer; warm/hot ⇒ offer/mechanism/review OR a warm/hot awareness stage).
 *   - `mismatch` — the ad's focal point is WRONG (cold ⇒ an offer/mechanism/review ad; warm/hot ⇒ a
 *                  pure curiosity/problem ad) — ranked to the TAIL, never used unless nothing better.
 *   - `neutral`  — no clear focal signal (an untagged skeleton with no offer) — eligible, mid-priority.
 *  A `mismatch` is a PARTITION not a FILTER (the shelf is never starved), but for cold it is what keeps
 *  Dahlia from imitating an offer/retargeting ad — closing the 2026-07-17 cold_offer_leak at its source
 *  (an offer-bearing ad is warm/hot; scrubbing its offer downstream was the band-aid). PURE. */
export function competitorTemperatureFit(
  angle: Pick<CompetitorAngle, "offer" | "conceptTags">,
  temperature: CreativeIntent["audience_temperature"],
): "match" | "neutral" | "mismatch" {
  // Precedence: an OFFER is a hard warm/hot tell (a discount ad is retargeting, whatever its stage);
  // then the AWARENESS STAGE is the direct audience signal (it wins over a softer lever/archetype hint
  // — a problem_aware ad is cold-appropriate even if it also uses social proof); the focal archetype /
  // lever is the tiebreak when the stage is untagged.
  const hasOffer = !!(angle.offer && angle.offer.trim());
  const stage = angle.conceptTags?.awareness_stage;
  if (temperature === "cold") {
    if (hasOffer) return "mismatch"; // an offer ⇒ warm/hot audience, never a cold prospecting base
    if (awarenessStageMatchesTemperature(stage, "cold")) return "match"; // unaware / problem_aware
    if (competitorFocalIsWarmHot(angle)) return "mismatch"; // no cold stage + a review/mechanism focal
    if (competitorFocalIsCold(angle)) return "match"; // curiosity / problem archetype
    return "neutral"; // untagged, no offer — eligible, mid-priority
  }
  // warm / hot
  if (awarenessStageMatchesTemperature(stage, temperature)) return "match";
  if (hasOffer || competitorFocalIsWarmHot(angle)) return "match"; // offer / review / mechanism fit warm/hot
  if (competitorFocalIsCold(angle)) return "mismatch"; // a pure cold curiosity/problem ad is a weak warm/hot base
  return "neutral";
}

/** Sort rank for `winner_tier` — the longitudinal signal from `creative_skeletons` (deriveWinnerTier
 *  in [[./creative-skeleton]]). Higher rank = ranked earlier. `proven` (≥21d persistence) leads,
 *  `building` (≥7d) follows, `new` (default, freshly-seen) below, `retired` (still_active=false)
 *  last. A null tier is treated like `new` — the ingest path always sets one, but older rows may
 *  predate it. Pure + exported for the Phase 1 vitest. */
export function winnerTierRank(tier: string | null | undefined): number {
  switch (tier) {
    case "proven":
      return 3;
    case "building":
      return 2;
    case "retired":
      return 0;
    case "new":
    case null:
    case undefined:
      return 1;
    default:
      return 1;
  }
}

type Admin = ReturnType<typeof createAdminClient>;
const GRAPH = "https://graph.facebook.com/v21.0";

async function graphGet(path: string, token: string): Promise<{ data?: Array<Record<string, unknown>> }> {
  const res = await fetch(`${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`graph_${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}
const actionVal = (actions: unknown, types: string[]): number => {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) { const m = (actions as Array<{ action_type: string; value: string }>).find((a) => a.action_type === t); if (m) return Number(m.value) || 0; }
  return 0;
};
const PURCHASE = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"];
const ADD_TO_CART = ["add_to_cart", "omni_add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"];

// ── Pool 1: proven competitor angles ─────────────────────────────────────────
export interface CompetitorAngle {
  advertiser: string | null;
  hook: string | null;
  framework: string | null;
  mechanismClaim: string | null;
  proof: string | null;
  offer: string | null;
  daysRunning: number | null;
  heat: number | null;
  destinationDomain: string | null;
  imageUrl: string | null;
  /** dahlia-deeper-competitor-selection Phase 2 — the still-running signal
   *  (`creative_skeletons.resume_advertising`). Used together with `daysRunning` + `heat` to
   *  derive per-angle acquisitionPower in `scoreCompetitorAcquisitionPower` (kills the old
   *  hardcoded `acquisitionPower=9`, so Dahlia can tell a deep+hot angle from a shallow one). */
  resumeAdvertising: boolean | null;
  /** dahlia-researches-from-winners-flow-ad-library Phase 1 — OUR longitudinal winner tier
   *  ([[./creative-skeleton]] `deriveWinnerTier`): `proven` (≥21d persistence across sweeps),
   *  `building` (≥7d), `new` (freshly-seen), `retired` (still_active=false). Ranks the winner
   *  library ahead of `days_running` (a competitor may have run an ad for 40 days once and
   *  killed it — still_active=false → retired, ranks last even at 40d). */
  winnerTier: string | null;
  /** dahlia-researches-from-winners-flow-ad-library Phase 1 — OUR longitudinal winner score
   *  (persistence days across sweeps). Mirrors the AdLibrary "composite" the spec names but is
   *  OUR signal (their composite was mis-parsed recency — dropped from the ingest per
   *  [[./creative-skeleton]] comments). Used as the winner-tier tiebreak inside a rank. */
  winnerScore: number | null;
  /** dahlia-researches-from-winners-flow-ad-library Phase 1 — the UNIFIED breakdown Dahlia +
   *  Max read as the imitation rubric ([[./creative-skeleton]] `ConceptTags`): angle,
   *  archetype, why_it_works, cialdini_lever, awareness_stage, format. LANE A + LANE B both
   *  emit this shape from OUR vision so Dahlia's research reads ONE schema regardless of
   *  origin. Consumed by `buildCreativeBrief` to surface unified-breakdown fields on the
   *  brief, and by Max (Phase 2) to grade competitor selection + temperature fit against the
   *  benchmark. */
  conceptTags: ConceptTags | null;
}

export interface CompetitorAngleOptions {
  /** Only angles a competitor has run at least this long (longevity = validated). Default 30. */
  minDaysRunning?: number;
  /** DELIBERATE per-product filter (CEO 2026-07-12): only skeletons scouted for THIS product's own
   *  competitors (`creative_skeletons.product_id`). This is how imitate reads a product's own shelf —
   *  strongly preferred over `niche`. When set, `niche` is ignored. */
  productId?: string;
  /** LEGACY substring filter on advertiser/hook/mechanism (e.g. "coffee", "weight"). Kept for callers
   *  that predate product tagging; superseded by `productId`. */
  niche?: string;
  limit?: number;
  /** dahlia-deeper-competitor-selection Phase 1 — raise the imitation bar. When true, the primary
   *  pool floors `days_running >= 60` AND filters `resume_advertising=true` (still running). If that
   *  deeply-proven pool is EMPTY for the product, fall back to the shallow 30d/no-resume pool AND
   *  return `usedFallback:true` + emit a `dahlia_deeply_proven_fallback` `director_activity` row so
   *  the fallback is VISIBLE (never silent). Callers that don't set this get the legacy 30d shape. */
  preferDeeplyProven?: boolean;
  /** dahlia-researches-from-winners-flow-ad-library Phase 1 — the declared-intent envelope that
   *  scopes research to temperature-appropriate winners. When set, the returned angles are
   *  re-ordered so those whose `concept_tags.awareness_stage` matches the temperature
   *  (cold→unaware/problem_aware · warm→solution_aware/product_aware · hot→most_aware) rank
   *  first; off-temp angles fill the remaining slots so a thin temperature-matched shelf never
   *  starves the batch. Callers that don't set intent get the unchanged (tier→score→days) order. */
  intent?: CreativeIntent;
}

export interface ProvenAnglesResult {
  angles: CompetitorAngle[];
  /** True when `preferDeeplyProven` was requested, the 60d/still-running pool was EMPTY, and the
   *  returned `angles` came from the shallow 30d/no-resume fallback. Also surfaced in
   *  `director_activity` (`action_kind='dahlia_deeply_proven_fallback'`) so it's audit-visible. */
  usedFallback: boolean;
}

interface QueryOptions {
  minDaysRunning: number;
  requireStillRunning: boolean;
  productId?: string;
  niche?: string;
  limit: number;
  /** dahlia-researches-from-winners-flow-ad-library Phase 1 — when set, the returned rows are
   *  re-partitioned so temperature-matching winners rank first (see `intent`). Off-temp rows
   *  fill the remaining slots — this is a PREFERENCE, never a filter, so a thin
   *  temperature-matched shelf never starves the batch. */
  intent?: CreativeIntent;
}

/** Coerce a jsonb concept_tags row into the shared `ConceptTags` shape, or null when the row
 *  predates the vision rubric. Pure — every unknown key is dropped, every present key is
 *  narrowed to string|null so downstream (`buildCreativeBrief`, Max's Phase 2 grader) reads a
 *  stable shape. */
function coerceConceptTags(raw: unknown): ConceptTags | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  return {
    angle: str(r.angle),
    archetype: str(r.archetype),
    why_it_works: str(r.why_it_works),
    cialdini_lever: str(r.cialdini_lever),
    awareness_stage: str(r.awareness_stage),
    format: str(r.format),
  };
}

/** Raw query — the shared pool reader used by both the legacy path and the two-tier
 *  deeply-proven path. Returns just the mapped rows; the two-tier logic + visible-fallback
 *  audit belong to `getProvenCompetitorAngles`.
 *
 *  dahlia-researches-from-winners-flow-ad-library Phase 1 — also selects the winners-flow
 *  longitudinal signals (`winner_tier`, `winner_score`, `concept_tags`) and re-ranks the
 *  returned rows: winner-tier rank (proven > building > new > retired) → winner_score →
 *  days_running. When `q.intent` is set, temperature-matching angles (by
 *  `concept_tags.awareness_stage`) are moved to the front of each rank bucket without
 *  dropping off-temp angles — a thin temperature shelf never starves the batch. */
async function queryProvenAngles(admin: Admin, workspaceId: string, q: QueryOptions): Promise<CompetitorAngle[]> {
  let query = admin
    .from("creative_skeletons")
    .select(
      "advertiser, hook, framework, mechanism_claim, proof, offer, days_running, heat, destination_domain, image_url, resume_advertising, winner_tier, winner_score, concept_tags",
    )
    .eq("workspace_id", workspaceId)
    .eq("status", "analyzed")
    // Dahlia makes STATIC ads, so she only imitates STATIC competitor ads — a video ad's composition
    // (its motion, its keyframe framing) does NOT transfer to a static creative (CEO 2026-07-17). The
    // status filter alone leaks PROCESSED videos onto the shelf: a video is routed to `video_pending`,
    // then the video pipeline drains it to `status='analyzed'` with `media_type='video'` — 25 such rows
    // were on the shelf. Filter to `media_type='static'` so the imitation base is always a static ad.
    .eq("media_type", "static")
    // flag-a-competitor-ad-do-not-use Phase 1: a proven long-runner is NOT automatically a good
    // imitation base (the Magic Mind display-box packshot vs. the Onnit "Lock in when it matters
    // most" hook — both proven long-runners, only one worth imitating). The CEO (and Phase 3's
    // Max grader) flags weak ads via `do_not_use`; the flag must NEVER become an imitation angle.
    .eq("do_not_use", false)
    .not("hook", "is", null)
    .gte("days_running", q.minDaysRunning)
    .order("days_running", { ascending: false, nullsFirst: false })
    .limit(q.limit);
  if (q.requireStillRunning) query = query.eq("resume_advertising", true);
  if (q.productId) query = query.eq("product_id", q.productId);
  else if (q.niche) query = query.or(`advertiser.ilike.%${q.niche}%,hook.ilike.%${q.niche}%,mechanism_claim.ilike.%${q.niche}%`);
  const { data } = await query;
  const mapped: CompetitorAngle[] = ((data ?? []) as Array<Record<string, unknown>>).map(mapRowToCompetitorAngle);
  return rankByWinnerSignalAndIntent(mapped, q.intent);
}

/** PURE — map ONE `creative_skeletons` row (the shared select column set) to a `CompetitorAngle`.
 *  Single source of truth for the mapping so `queryProvenAngles` (the shelf reader) and
 *  `getCompetitorAngleBySkeletonId` (the pinned-ad reader) can never drift. */
export function mapRowToCompetitorAngle(r: Record<string, unknown>): CompetitorAngle {
  return {
    advertiser: (r.advertiser as string | null) ?? null,
    hook: (r.hook as string | null) ?? null,
    framework: (r.framework as string | null) ?? null,
    mechanismClaim: (r.mechanism_claim as string | null) ?? null,
    proof: (r.proof as string | null) ?? null,
    offer: (r.offer as string | null) ?? null,
    daysRunning: r.days_running == null ? null : Number(r.days_running),
    heat: r.heat == null ? null : Number(r.heat),
    destinationDomain: (r.destination_domain as string | null) ?? null,
    imageUrl: (r.image_url as string | null) ?? null,
    resumeAdvertising: typeof r.resume_advertising === "boolean" ? (r.resume_advertising as boolean) : null,
    winnerTier: (r.winner_tier as string | null) ?? null,
    winnerScore: r.winner_score == null ? null : Number(r.winner_score),
    conceptTags: coerceConceptTags(r.concept_tags),
  };
}

/** Load ONE competitor ad by `creative_skeletons.id` as a `CompetitorAngle` — the imitation base
 *  when the owner PINS a specific ad from the Research › Ads "Generate ad" panel. Deliberately does
 *  NOT apply the shelf filters (`status`/`media_type`/`do_not_use`/`days_running`) — an explicit
 *  human pick overrides the auto-selection guards. Scoped to the workspace. Returns null when the
 *  id doesn't resolve (→ `stockProduct` falls back to normal shelf ranking + warns). */
export async function getCompetitorAngleBySkeletonId(
  admin: Admin,
  workspaceId: string,
  skeletonId: string,
): Promise<CompetitorAngle | null> {
  const { data } = await admin
    .from("creative_skeletons")
    .select(
      "advertiser, hook, framework, mechanism_claim, proof, offer, days_running, heat, destination_domain, image_url, resume_advertising, winner_tier, winner_score, concept_tags",
    )
    .eq("workspace_id", workspaceId)
    .eq("id", skeletonId)
    .maybeSingle();
  if (!data) return null;
  return mapRowToCompetitorAngle(data as Record<string, unknown>);
}

/** Winner-tier-first ranking + optional intent-scoped partition. Pure so a unit test can pin
 *  every branch. `retired` sinks last even at high `days_running` — a competitor's killed ad is
 *  not a research base regardless of how long it ran. Same-rank ties fall to `winner_score`
 *  desc then `days_running` desc. When `intent.audience_temperature` is set, angles whose
 *  concept_tags.awareness_stage matches the temperature move to the FRONT while preserving the
 *  within-group order — off-temperature angles stay reachable at the tail. */
export function rankByWinnerSignalAndIntent(
  angles: CompetitorAngle[],
  intent?: CreativeIntent,
): CompetitorAngle[] {
  const ranked = angles.slice().sort((a, b) => {
    const rankDiff = winnerTierRank(b.winnerTier) - winnerTierRank(a.winnerTier);
    if (rankDiff !== 0) return rankDiff;
    const scoreDiff = (b.winnerScore ?? 0) - (a.winnerScore ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.daysRunning ?? 0) - (a.daysRunning ?? 0);
  });
  if (!intent) return ranked;
  // Partition by temperature FIT (focal point), winner-tier order preserved within each bucket:
  // match (right focal point) → neutral (no signal) → mismatch (wrong focal point — e.g. an offer ad
  // for a cold audience) at the tail. This is what steers Dahlia to imitate a curiosity/problem ad
  // for cold and an offer/mechanism/review ad for warm/hot (CEO 2026-07-17), replacing the
  // awareness_stage-only partition (which ignored the offer + archetype focal signals).
  const match: CompetitorAngle[] = [];
  const neutral: CompetitorAngle[] = [];
  const mismatch: CompetitorAngle[] = [];
  for (const a of ranked) {
    const fit = competitorTemperatureFit(a, intent.audience_temperature);
    (fit === "match" ? match : fit === "mismatch" ? mismatch : neutral).push(a);
  }
  return [...match, ...neutral, ...mismatch];
}

/**
 * dahlia-deeper-competitor-selection Phase 2 — derive per-angle `acquisitionPower` (0..10)
 * from the actual creative_skeletons signal set instead of the old hardcoded `acquisitionPower=9`.
 *
 * The score is a piecewise base on `daysRunning` × `resumeAdvertising` (the depth-of-proof + is-
 * still-running signals) with a `heat` tiebreak (how discriminating the skeleton library rated the
 * ad). This lets Dahlia's `stockProduct` sort competitor imitation bases by DEPTH — a 60d+
 * still-running high-heat angle outranks a 30d dormant low-heat one — instead of flattening every
 * competitor angle to a single constant. The tiebreak keeps the metric monotonic: same depth-bucket
 * → higher heat wins; a dormant/low-heat row costs 1 point (never below 0).
 *
 * Contract (pinned by creative-sourcing.acquisition-power.test.ts):
 *  - 60d+ AND resume=true            → base 9  (deeply-proven + still running)
 *  - 60d+ but resume≠true            → base 7  (deep but paused — weaker imitation base)
 *  - 30–59d AND resume=true          → base 7  (shallow but still running)
 *  - 30–59d and resume≠true          → base 5  (shallow + paused — a 30d ad that may already be dead)
 *  - <30d or null daysRunning        → base 4  (below the shallow floor)
 *  Heat tiebreak (skeleton heat/dormancy signal):
 *   +1 when heat ≥ 4 (capped at 10);  −1 when heat ≤ 1 or heat null (floored at 0).
 */
export function scoreCompetitorAcquisitionPower(angle: {
  daysRunning: number | null;
  heat: number | null;
  resumeAdvertising: boolean | null;
}): number {
  const days = angle.daysRunning ?? 0;
  const stillRunning = angle.resumeAdvertising === true;
  let base: number;
  if (days >= 60 && stillRunning) base = 9;
  else if (days >= 60) base = 7;
  else if (days >= 30 && stillRunning) base = 7;
  else if (days >= 30) base = 5;
  else base = 4;
  const heat = angle.heat;
  let bonus = 0;
  if (heat != null && heat >= 4) bonus = 1;
  else if (heat == null || heat <= 1) bonus = -1;
  return Math.min(10, Math.max(0, base + bonus));
}

/** Ranked proven competitor angles from the creative-skeleton library — the strongest idea pool (real
 *  market-validated hooks, ranked by how long the competitor has kept spending on them). Pass `productId`
 *  to read exactly that product's deliberately-chosen competitor shelf (the imitate→innovate path).
 *
 *  Pass `preferDeeplyProven:true` (Dahlia's imitate-then-innovate stockProduct — Phase 1 of
 *  [[../../../docs/brain/specs/dahlia-deeper-competitor-selection.md]]) to raise the bar: the primary
 *  pool becomes `days_running >= 60` + `resume_advertising=true`. On an EMPTY deeply-proven pool the
 *  function falls back to the shallow 30d/no-resume pool, sets `usedFallback:true`, AND emits a
 *  `dahlia_deeply_proven_fallback` `director_activity` row so a thin-shelf product's fallback is
 *  audit-visible (never silent). */
export async function getProvenCompetitorAngles(
  admin: Admin,
  workspaceId: string,
  opts: CompetitorAngleOptions = {},
): Promise<ProvenAnglesResult> {
  const shallowMinDays = opts.minDaysRunning ?? 30;
  const limit = opts.limit ?? 40;

  if (opts.preferDeeplyProven) {
    const deep = await queryProvenAngles(admin, workspaceId, {
      minDaysRunning: Math.max(60, shallowMinDays),
      requireStillRunning: true,
      productId: opts.productId,
      niche: opts.niche,
      limit,
      intent: opts.intent,
    });
    if (deep.length > 0) return { angles: deep, usedFallback: false };

    // Empty deeply-proven pool → fall back visibly. Best-effort audit write; a director_activity
    // insert crash must NOT starve Dahlia of its shelf (mirrors recordDirectorActivity contract).
    const fallback = await queryProvenAngles(admin, workspaceId, {
      minDaysRunning: shallowMinDays,
      requireStillRunning: false,
      productId: opts.productId,
      niche: opts.niche,
      limit,
      intent: opts.intent,
    });
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: "growth",
      actionKind: "dahlia_deeply_proven_fallback",
      specSlug: "dahlia-deeper-competitor-selection",
      reason: `deeply-proven pool empty (${Math.max(60, shallowMinDays)}d + still-running) for ${
        opts.productId ? `product ${opts.productId}` : opts.niche ? `niche "${opts.niche}"` : "workspace-wide"
      } — fell back to the ${shallowMinDays}d/no-resume pool (${fallback.length} angle${fallback.length === 1 ? "" : "s"}). A thin competitor shelf, not silence.`,
      metadata: {
        product_id: opts.productId ?? null,
        niche: opts.niche ?? null,
        deeply_proven_min_days: Math.max(60, shallowMinDays),
        fallback_min_days: shallowMinDays,
        fallback_pool_size: fallback.length,
        autonomous: true,
      },
    }).catch((e) => {
      console.warn("dahlia_deeply_proven_fallback_activity_failed", {
        workspaceId,
        productId: opts.productId ?? null,
        err: errText(e),
      });
    });
    return { angles: fallback, usedFallback: true };
  }

  const angles = await queryProvenAngles(admin, workspaceId, {
    minDaysRunning: shallowMinDays,
    requireStillRunning: false,
    productId: opts.productId,
    niche: opts.niche,
    limit,
    intent: opts.intent,
  });
  return { angles, usedFallback: false };
}

// ── The performance analyzer (per-ad, Meta ground truth) ─────────────────────
export interface AdPerformance {
  name: string;
  effectiveStatus: string;
  spendCents: number;
  impressions: number;
  purchases: number;
  addToCart: number;
  /** validated leading signal: spend ÷ add_to_cart (cents), null if no ATC. */
  costPerAtcCents: number | null;
  /** cost per purchase (cents), null if none. */
  cppCents: number | null;
  /** validated: spend per 1000 impressions (cents). */
  cpmCents: number;
  ctrPct: number;
  reactions: number;
  saves: number;
  shares: number;
}

/** Per-ad performance for an account (Meta ground truth) with the FULL validated indicator set. `datePreset`
 *  defaults to lifetime (`maximum`). Reactions/CTR are included for visibility but are TRAPS — winners are
 *  chosen on cost-per-ATC + CPM (proven on 99 historical ads). */
export async function analyzeAccountAds(token: string, bareMetaAccountId: string, opts: { datePreset?: string } = {}): Promise<AdPerformance[]> {
  const preset = opts.datePreset ?? "maximum";
  const res = await graphGet(`act_${bareMetaAccountId}/ads?fields=name,effective_status,insights.date_preset(${preset}){spend,impressions,ctr,actions}&limit=300`, token);
  const out: AdPerformance[] = [];
  for (const ad of (res.data ?? []) as Array<Record<string, unknown>>) {
    const ins = (ad.insights as { data?: Array<Record<string, unknown>> } | undefined)?.data?.[0];
    if (!ins) continue;
    const spend = Number(ins.spend ?? 0), imp = Number(ins.impressions ?? 0);
    const pur = actionVal(ins.actions, PURCHASE), atc = actionVal(ins.actions, ADD_TO_CART);
    out.push({
      name: String(ad.name ?? "").slice(0, 60),
      effectiveStatus: String(ad.effective_status ?? ""),
      spendCents: Math.round(spend * 100),
      impressions: imp,
      purchases: pur,
      addToCart: atc,
      costPerAtcCents: atc > 0 ? Math.round((spend / atc) * 100) : null,
      cppCents: pur > 0 ? Math.round((spend / pur) * 100) : null,
      cpmCents: imp > 0 ? Math.round((spend / imp) * 1000 * 100) : 0,
      ctrPct: Number(ins.ctr ?? 0),
      reactions: actionVal(ins.actions, ["post_reaction"]),
      saves: actionVal(ins.actions, ["onsite_conversion.post_save"]),
      shares: actionVal(ins.actions, ["post"]),
    });
  }
  return out;
}

// ── Pool 3: our own winning angles ───────────────────────────────────────────
export interface OurWinningAd extends AdPerformance {
  isCrownEligible: boolean; // CPP <= maxCpaCents AND spend >= minSpendCents
  isCandidate: boolean; // CPP <= maxCpaCents (converting), not yet at the spend floor
}

/** Our OWN best-performing ads for an account, ranked by cost-per-ATC then CPP — "what works for US".
 *  The exploit seed: these are the concepts/creatives to make variations of. */
export async function getOurWinningAngles(
  admin: Admin,
  workspaceId: string,
  bareMetaAccountId: string,
  opts: { maxCpaCents?: number; minSpendCents?: number } = {},
): Promise<OurWinningAd[]> {
  const token = await getMetaUserToken(workspaceId);
  if (!token) return [];
  const maxCpa = opts.maxCpaCents ?? 15000, minSpend = opts.minSpendCents ?? 45000;
  const ads = await analyzeAccountAds(token, bareMetaAccountId);
  return ads
    .filter((a) => a.purchases > 0 || a.addToCart > 0)
    .map((a) => ({ ...a, isCrownEligible: a.cppCents != null && a.cppCents <= maxCpa && a.spendCents >= minSpend, isCandidate: a.cppCents != null && a.cppCents <= maxCpa }))
    .sort((a, b) => (a.costPerAtcCents ?? 9e9) - (b.costPerAtcCents ?? 9e9) || (a.cppCents ?? 9e9) - (b.cppCents ?? 9e9));
}
