/**
 * market-sophistication — the +1 escalation POLICY over the M2 Five Frameworks
 * shelf-modal detector ([[./sophistication]] `computeSophisticationLevel`).
 *
 * Where the shelf-modal returns the level the market is ALREADY writing at,
 * Schwartz explicitly warns that writing AT the modal is the failure mode
 * ("everyone at level Y-1 loses"). This helper reads the product's own
 * deliberately-chosen competitor shelf via
 * [[./creative-sourcing]] `getProvenCompetitorAngles({productId, minDaysRunning: 30})`
 * (the per-product filter is what makes "the shelf" mean "this product's
 * shelf" — [[../../../docs/brain/tables/creative_skeletons.md]] line 50:
 * product_id is the deliberate imitate link), delegates to
 * `computeSophisticationLevel(shelf)` to get the shelfModal, and applies the
 * escalation policy: `targetLevel = Math.min(5, shelfModal + 1)`.
 *
 * The evidence[] returned alongside is the audit trail the founder can read
 * to answer "why did Dahlia write at L4?" — one string per contributing
 * competitor angle in the shape
 * `advertiser=<advertiser> level=L<level> hook=<hook slice(0,80)>`. Empty
 * shelf → the single default marker
 * `no proven competitor shelf — defaulting to mid-market` so the audit trail
 * is never silent.
 *
 * Consumer: [[./creative-agent]] `stockProduct` calls this in place of the
 * direct `computeSophisticationLevel(sourced)` call and threads
 * `target_schwartz_level = result.targetLevel` + `market_sophistication_evidence
 * = result.evidence` into Dahlia's per-creative author-mode session input.
 *
 * Empty-shelf policy: `{shelfModal:3, targetLevel:4}` — safe default that
 * assumes a mid-market and writes one step above.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { getProvenCompetitorAngles, type CompetitorAngle } from "@/lib/ads/creative-sourcing";
import { classifyAngleSchwartzLevel, computeSophisticationLevel, type SchwartzLevel } from "@/lib/ads/sophistication";

type Admin = ReturnType<typeof createAdminClient>;

export interface MarketSophistication {
  /** The modal Schwartz awareness level the competitor shelf is writing at
   *  (1..5) — from the same M2 `computeSophisticationLevel` helper. */
  shelfModal: SchwartzLevel;
  /** The escalated target level: `min(5, shelfModal + 1)`. This is what
   *  Dahlia writes AT — the shelf modal is `target-1`; everyone at
   *  target-1 loses because the market already heard it and yawns. */
  targetLevel: SchwartzLevel;
  /** Per-competitor-angle audit trail (one line per contributing angle) so
   *  the founder can answer "why did Dahlia write at L4?" without a
   *  second DB round-trip. Empty shelf → one default marker. */
  evidence: string[];
}

/** Escalate the shelf modal by +1, clamped at 5. Pure — every caller uses
 *  this so the policy can never diverge. */
export function escalateShelfModal(shelfModal: SchwartzLevel): SchwartzLevel {
  return Math.min(5, shelfModal + 1) as SchwartzLevel;
}

/** Format one contributing angle as an audit line. */
function formatEvidenceLine(angle: CompetitorAngle): string {
  const level = classifyAngleSchwartzLevel(angle);
  const advertiser = angle.advertiser ?? "unknown";
  const hookSource = angle.hook ?? "";
  const hook = hookSource.length > 80 ? hookSource.slice(0, 80) : hookSource;
  return `advertiser=${advertiser} level=L${level} hook=${hook}`;
}

/** Pure helper — derive shelfModal + targetLevel + evidence[] from a shelf.
 *  Extracted so the test can pin the escalation policy without a DB mock. */
export function computeMarketSophisticationFromShelf(shelf: readonly CompetitorAngle[]): MarketSophistication {
  if (!shelf || shelf.length === 0) {
    return {
      shelfModal: 3,
      targetLevel: 4,
      evidence: ["no proven competitor shelf — defaulting to mid-market"],
    };
  }
  const shelfModal = computeSophisticationLevel(shelf);
  const targetLevel = escalateShelfModal(shelfModal);
  const evidence = shelf.map(formatEvidenceLine);
  return { shelfModal, targetLevel, evidence };
}

/** The DB-backed entry point stockProduct calls. Reads THIS product's
 *  deliberately-chosen competitor shelf via `getProvenCompetitorAngles(
 *  {productId, minDaysRunning: 30})` — the per-product filter is what makes
 *  "the shelf" mean "this product's shelf" (creative_skeletons.product_id is
 *  the deliberate imitate link). On any read error the shelf is treated as
 *  empty (safe mid-market default); a starved shelf must NEVER crash Dahlia
 *  out of the copy-author lane. */
export type GetProvenCompetitorAnglesFn = typeof getProvenCompetitorAngles;

export async function computeMarketSophistication(
  admin: Admin,
  workspaceId: string,
  productId: string,
  /** Injected only by the test — production callers use the module default. */
  getAngles: GetProvenCompetitorAnglesFn = getProvenCompetitorAngles,
): Promise<MarketSophistication> {
  const { angles } = await getAngles(admin, workspaceId, { productId, minDaysRunning: 30 }).catch(() => ({
    angles: [] as CompetitorAngle[],
    usedFallback: false,
  }));
  return computeMarketSophisticationFromShelf(angles);
}
