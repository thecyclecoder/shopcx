/**
 * Situation miner — the DETERMINISTIC verify-and-screen apply step for the `situation-mine` box
 * lane (docs/brain/libraries/situation-miner.md · Phase 1 of the "mine customer situations for
 * every advertised product" spec).
 *
 * THE MODEL ONLY PROPOSES; THIS CODE VERIFIES. A Max box session reads one advertised product's
 * best reviews and proposes `{situations: [...]}`, but an LLM can paraphrase or invent, so NOTHING
 * it proposes is trusted. `applySituationMine` is the sole mutator: for every proposed quote it
 * requires `verbatim_phrase` to be a case-insensitive substring of the cited review's body (drop
 * otherwise — no fabricated quotes), screens every quote AND every situation text field through
 * `checkClaim` (src/lib/shopping-agent/compliance.ts — the same FDA/FTC structure/function block
 * list the shopping agent enforces), and only then upserts through the customer-situations SDK.
 *
 * Compliance contract (mirrors the SDK's north-star invariant):
 *   - A quote that fails `checkClaim` is STORED with `compliance_ok=false` + a note (for audit) —
 *     the SDK's surface-side filter strips it before it can reach a shopper.
 *   - A SITUATION whose situation/who/goal/noticed text fails `checkClaim` is DROPPED whole (a
 *     non-compliant framing must never be published, even stripped of quotes).
 *   - A situation with zero compliant quotes is STORED with `compliance_ok=false`.
 *   - `source='mine:<ISO date>'`; a slug already held by a `seed:*` row is NEVER overwritten.
 *
 * This module never runs an LLM — same shape as `applyBoxImitationQualityReview`. The box session
 * in `scripts/builder-worker.ts` `runSituationMineJob` is the only LLM caller; it hands the parsed
 * proposal here.
 *
 * Node-completeness trio (CLAUDE.md hard rule): OWNER `cmo` in
 * [[control-tower/node-registry]] `KIND_OWNER_FALLBACK` (the CMO owns the organic-discovery
 * surface); KILL-SWITCH ancestry inherited from `director:cmo` via the node registry; HEARTBEAT
 * emitted by `runSituationMineJob` via `emitAgentHeartbeat('situation-mine', …)` in a try/finally.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { checkClaim } from "@/lib/shopping-agent/compliance";
import {
  upsertSituations,
  listSituations,
  type CustomerSituationRow,
  type SituationQuote,
  type UpsertSituationInput,
} from "@/lib/customer-situations";

type Admin = ReturnType<typeof createAdminClient>;

/** A best-review handed to the box session and re-used here to verify its quotes verbatim. */
export interface MineReview {
  id: string;
  reviewer: string;
  rating: number;
  verified_purchase: boolean;
  featured: boolean;
  body: string;
}

/** One quote the box session proposes — cites a review id and the exact phrase it pulled. */
export interface ProposedQuote {
  review_id: string;
  verbatim_phrase: string;
}

/** One situation the box session proposes. */
export interface ProposedSituation {
  slug: string;
  situation: string;
  who?: string | null;
  goal?: string | null;
  noticed?: string | null;
  timeframe?: string | null;
  quotes?: ProposedQuote[];
}

/** The box session's whole output, post-JSON-parse. */
export interface SituationMineProposal {
  situations: ProposedSituation[];
}

/** Per-run counts the lane logs so the CMO can supervise the proxy (proposed vs written). */
export interface SituationMineResult {
  proposed: number;
  /** quotes dropped because the phrase isn't a verbatim substring of its cited review */
  verbatimDropped: number;
  /** situations dropped because a situation/who/goal/noticed field failed the compliance block list */
  complianceDroppedSituations: number;
  /** quotes stored compliance_ok=false (failed the block list) — kept for audit, never surfaced */
  complianceFlaggedQuotes: number;
  /** situations stored compliance_ok=false because they ended with zero compliant quotes */
  storedNonCompliant: number;
  /** slugs skipped because a seed:* row already holds them */
  skippedSeed: number;
  written: number;
  rows: CustomerSituationRow[];
}

/** A slug normalized for the SDK conflict key — lowercase, kebab, trimmed. */
function normalizeSlug(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** True iff `needle` is a case-insensitive substring of `haystack` (verbatim verification). */
function isVerbatimSubstring(needle: string, haystack: string): boolean {
  if (!needle || !needle.trim() || !haystack) return false;
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
}

/**
 * Apply one product's mined situations. The ONLY write path for a mined situation. Verifies every
 * quote verbatim against the real review body, compliance-screens every quote + situation text,
 * and upserts through `upsertSituations` with `source='mine:<date>'` — never touching a slug a
 * `seed:*` row already owns.
 */
export async function applySituationMine(input: {
  admin?: Admin;
  workspaceId: string;
  productId: string;
  /** ISO date (YYYY-MM-DD) stamped into `source='mine:<date>'`. */
  mineDateISO: string;
  /** The best-reviews set shown to the box session — used to verify each cited quote verbatim. */
  reviews: MineReview[];
  proposal: SituationMineProposal;
}): Promise<SituationMineResult> {
  const admin = input.admin ?? createAdminClient();
  const reviewById = new Map<string, MineReview>(input.reviews.map((r) => [r.id, r]));

  // Slugs already held by a seed:* row must never be overwritten by a mine. Load unfiltered
  // (compliantOnly:false) so we see every existing row for this product, compliant or not.
  const existing = await listSituations(admin, input.workspaceId, {
    productId: input.productId,
    compliantOnly: false,
    limit: 500,
  });
  const seedSlugs = new Set(
    existing.filter((r) => (r.source ?? "").startsWith("seed:")).map((r) => r.slug),
  );

  const result: SituationMineResult = {
    proposed: 0,
    verbatimDropped: 0,
    complianceDroppedSituations: 0,
    complianceFlaggedQuotes: 0,
    storedNonCompliant: 0,
    skippedSeed: 0,
    written: 0,
    rows: [],
  };

  const proposals = Array.isArray(input.proposal?.situations) ? input.proposal.situations : [];
  const payload: UpsertSituationInput[] = [];
  const seenSlugs = new Set<string>();

  for (const p of proposals) {
    result.proposed += 1;
    const slug = normalizeSlug(p?.slug ?? "");
    if (!slug || !p?.situation || !p.situation.trim()) continue;

    // Never clobber a hand-seeded row; de-dupe within this batch (last proposal for a slug wins
    // is avoided — first wins, later dupes skipped so the batch upsert can't collide on itself).
    if (seedSlugs.has(slug)) {
      result.skippedSeed += 1;
      continue;
    }
    if (seenSlugs.has(slug)) continue;

    // Screen every situation TEXT field — a non-compliant framing drops the whole situation.
    const textFields = [p.situation, p.who ?? "", p.goal ?? "", p.noticed ?? ""];
    let textFailed = false;
    for (const t of textFields) {
      if (t && t.trim() && !checkClaim(t).ok) {
        textFailed = true;
        break;
      }
    }
    if (textFailed) {
      result.complianceDroppedSituations += 1;
      continue;
    }

    // Verify + screen each quote.
    const quotes: SituationQuote[] = [];
    const reviewIds = new Set<string>();
    for (const q of p.quotes ?? []) {
      const review = q?.review_id ? reviewById.get(q.review_id) : undefined;
      if (!review || !isVerbatimSubstring(q?.verbatim_phrase ?? "", review.body ?? "")) {
        // Not a verbatim substring of the cited review (or the review wasn't in the set) — drop.
        result.verbatimDropped += 1;
        continue;
      }
      const claim = checkClaim(q.verbatim_phrase);
      if (!claim.ok) result.complianceFlaggedQuotes += 1;
      quotes.push({
        review_id: review.id,
        reviewer: review.reviewer,
        rating: review.rating,
        verified_purchase: review.verified_purchase,
        featured: review.featured,
        verbatim_phrase: q.verbatim_phrase,
        compliance_ok: claim.ok,
        compliance_note: claim.ok
          ? ""
          : `blocked: ${claim.category ?? "unknown"}${claim.matched ? ` ("${claim.matched}")` : ""}`,
      });
      reviewIds.add(review.id);
    }

    const compliantQuotes = quotes.filter((x) => x.compliance_ok);
    const situationCompliant = compliantQuotes.length > 0;
    if (!situationCompliant) result.storedNonCompliant += 1;

    seenSlugs.add(slug);
    payload.push({
      product_id: input.productId,
      slug,
      situation: p.situation.trim(),
      who: p.who?.trim() || null,
      goal: p.goal?.trim() || null,
      noticed: p.noticed?.trim() || null,
      timeframe: p.timeframe?.trim() || null,
      verbatim_phrase: compliantQuotes[0]?.verbatim_phrase ?? quotes[0]?.verbatim_phrase ?? null,
      review_ids: Array.from(reviewIds),
      quotes,
      compliance_ok: situationCompliant,
      compliance_note: situationCompliant ? null : "no compliant verbatim quote survived verification",
      source: `mine:${input.mineDateISO}`,
      active: true,
    });
  }

  if (payload.length > 0) {
    const rows = await upsertSituations(admin, input.workspaceId, payload);
    result.rows = rows;
    result.written = rows.length;
  }
  return result;
}
