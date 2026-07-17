/**
 * Account Matching — single source of truth for finding potential linked accounts.
 * Used by: unified ticket handler (detection), journey step builder (building steps),
 * Sol's first-touch investigation + June's director review, and the portal link prompt.
 *
 * Two things a matcher must do (CLAUDE.md: account linking is FUNDAMENTAL to ticket handling):
 *   1. Surface accounts that are the SAME PERSON but not yet linked — not just resolve an
 *      existing link group.
 *   2. Grade its confidence so a COMMON NAME ("Elizabeth Johnson" → 16 namesakes) doesn't drown
 *      the ONE real duplicate. The strongest same-person signal is a shared street ADDRESS (or a
 *      shared phone). Ticket db8b3d66 is the wedge: Elizabeth's real second account (same first+last
 *      name, same exact address, created 3s apart) was indistinguishable from 15 random
 *      "Elizabeth Johnson"s under name-only matching, got swept into a single bulk "reject all", and
 *      was then permanently hidden — so Sol/June truthfully but wrongly reported "no active
 *      subscription / no such charge" while a live sub kept billing on the sibling account.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { canonicalizeEmail } from "@/lib/email-utils";

type Admin = ReturnType<typeof createAdminClient>;

/** Which same-person signals a candidate matched on. */
export type MatchSignal = "name" | "phone" | "email" | "address";

/**
 * high = a strong same-person signal that a common name cannot fake: a shared street address
 *        CORROBORATING a name match, or a shared phone number. Safe to prompt/propose a link on.
 * low  = name-only / email-local-only — real for a rare name, noise for a common one. Surface, but
 *        never auto-link and never let it drown a `high`.
 */
export type MatchConfidence = "high" | "low";

export interface PotentialMatch {
  id: string;
  email: string;
  /** graded so callers can prioritise a shared-address match over common-name noise. */
  confidence: MatchConfidence;
  /** the signals this candidate matched on (for the agent/UI to explain WHY). */
  signals: MatchSignal[];
  /** true when a prior `customer_link_rejections` row exists for this pair — a `high` match
   *  re-surfaces DESPITE it (the rejection was made on weaker, pre-address evidence), flagged so the
   *  caller treats it as a re-confirm, never a silent auto-link. */
  previously_rejected: boolean;
}

/** Normalise a street/zip/name token for equality: trim + collapse whitespace + lowercase. */
export function normAddr(v: unknown): string {
  return String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** A candidate row with the raw signals it matched on — the input to the pure grader. */
export interface CandidateInput {
  id: string;
  email: string;
  last_name: string | null;
  address1: unknown;
  zip: unknown;
  /** signals matched by the indexed branches (name / phone / email); "address" is added by the grader. */
  signals: MatchSignal[];
}

/** The source customer's identity fields the grader corroborates candidates against. */
export interface GradeSource {
  last_name: string | null;
  address1: unknown;
  zip: unknown;
}

/**
 * PURE grading: given the source customer, the merged candidate rows, and the already-linked +
 * previously-rejected id sets, return graded matches (high first). No DB access — unit-pinned.
 *
 * - "address" signal is added when a candidate's address1+zip equals the source's.
 * - high = (address corroborates a shared last name) OR phone; else low.
 * - already-linked → excluded; low+rejected → excluded; high+rejected → surfaced, previously_rejected.
 */
export function gradeUnlinkedCandidates(
  source: GradeSource,
  candidates: CandidateInput[],
  linkedIds: Set<string>,
  rejectedIds: Set<string>,
): PotentialMatch[] {
  const srcAddr1 = normAddr(source.address1);
  const srcZip = normAddr(source.zip);
  const srcLast = normAddr(source.last_name);

  const graded: PotentialMatch[] = [];
  for (const c of candidates) {
    if (linkedIds.has(c.id)) continue;
    const signals = new Set<MatchSignal>(c.signals);
    const a1 = normAddr(c.address1);
    const zip = normAddr(c.zip);
    if (srcAddr1 && srcZip && a1 === srcAddr1 && zip === srcZip) signals.add("address");

    const addrCorroboratesName = signals.has("address") && !!srcLast && normAddr(c.last_name) === srcLast;
    const confidence: MatchConfidence = (addrCorroboratesName || signals.has("phone")) ? "high" : "low";
    const previously_rejected = rejectedIds.has(c.id);
    if (previously_rejected && confidence === "low") continue;
    graded.push({ id: c.id, email: c.email, confidence, signals: Array.from(signals), previously_rejected });
  }

  graded.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "high" ? -1 : 1;
    return b.signals.length - a.signals.length;
  });
  return graded.slice(0, 10);
}

/**
 * Find potential unlinked account matches for a customer, graded by confidence.
 *
 * Matching runs one indexed query per branch (name / phone / email-local) — the same
 * pool-safe shape as before (a mixed OR forced a 620k-row Seq Scan: supabase-logs
 * b5db594131381078). ADDRESS is then corroborated IN MEMORY over that small candidate set (fetched
 * by id — indexed), so there is no unindexed address scan: a shared street address only matters for
 * someone who already shares a name/phone/email, which is exactly a same-person duplicate.
 *
 * Rejection semantics: an already-LINKED account is always excluded. A previously REJECTED account
 * is excluded when the match is `low`, but a `high` (address- or phone-corroborated) match
 * re-surfaces with `previously_rejected: true` — a weak name-only rejection must not permanently
 * bury a strong same-person match (the db8b3d66 bug).
 *
 * @returns Graded unlinked matches, `high` first. Empty = no linking needed.
 */
export async function findUnlinkedMatches(
  workspaceId: string,
  customerId: string,
  adminClient?: Admin,
): Promise<PotentialMatch[]> {
  const admin = adminClient || createAdminClient();

  const { data: customer } = await admin.from("customers")
    .select("id, email, phone, first_name, last_name, default_address")
    .eq("id", customerId).single();

  if (!customer) return [];

  // One indexed query per branch (Bitmap Index Scan on idx_customers_name_match / _phone /
  // _email_trgm), tagged with the signal it represents, then merged in memory.
  const baseFilter = () => admin.from("customers")
    .select("id, email, phone, first_name, last_name, default_address")
    .eq("workspace_id", workspaceId)
    .neq("id", customerId)
    .neq("email", customer.email)
    .limit(10);

  type CandRow = {
    id: string; email: string; phone: string | null;
    first_name: string | null; last_name: string | null;
    default_address: Record<string, unknown> | null;
  };
  const branches: Array<{ signal: MatchSignal; q: PromiseLike<{ data: CandRow[] | null }> }> = [];
  if (customer.first_name && customer.last_name) {
    branches.push({ signal: "name", q: baseFilter().eq("first_name", customer.first_name).eq("last_name", customer.last_name) });
  }
  if (customer.phone) branches.push({ signal: "phone", q: baseFilter().eq("phone", customer.phone) });
  // Email branch — match on the shared `email_canonical` key so Gmail dot/plus/googlemail
  // variants of the same real inbox surface as candidates for grading. Rides the composite
  // index `idx_customers_email_canonical (workspace_id, email_canonical)` added in migration
  // 20261104120000 (identity-gmail-canonicalization-and-dot-insensitive-matching Phase 2).
  // Previously this was an exact `email-local ilike` — which correctly matched
  // `julie@gmail.com` against `julie@yahoo.com` (same local, wrong provider) BUT missed
  // `metz.julie323@gmail.com` vs `metzjulie323@gmail.com` (dot-variant of the same inbox,
  // ticket 54f0f29e). Canonical equality is the identity-correct widening:
  //   - Gmail dots/+tags collapse    → same canonical → surfaces the twin
  //   - googlemail.com alias         → same canonical (normalized to gmail.com) → surfaces
  //   - Non-gmail providers          → email_canonical == trimmed+lowered email, so
  //                                    `julie@yahoo.com` and `julie@fastmail.com` remain
  //                                    DISTINCT (dots stay significant outside Gmail).
  // Grader is unchanged — this only widens the candidate set the pure grader sees; a
  // name/address/phone corroboration is still required for `high` confidence.
  const sourceCanonical = canonicalizeEmail(customer.email ?? "");
  if (sourceCanonical) {
    branches.push({
      signal: "email",
      q: baseFilter().eq("email_canonical", sourceCanonical),
    });
  }

  if (!branches.length) return [];

  // Merge branch results, dedupe by id, accumulating the signals each candidate matched on.
  const byId = new Map<string, { row: CandRow; signals: Set<MatchSignal> }>();
  const results = await Promise.all(branches.map((b) => b.q.then((r) => ({ signal: b.signal, data: r.data }))));
  for (const { signal, data } of results) {
    for (const row of data || []) {
      const entry = byId.get(row.id) ?? { row, signals: new Set<MatchSignal>() };
      entry.signals.add(signal);
      byId.set(row.id, entry);
    }
  }

  const candidateIds = Array.from(byId.keys()).slice(0, 20);
  if (!candidateIds.length) return [];

  // Already-linked → always exclude (already one group).
  const { data: existingLinks } = await admin.from("customer_links")
    .select("customer_id").in("customer_id", candidateIds);
  const linkedIds = new Set((existingLinks || []).map(l => l.customer_id));

  // Previously rejected pairs — the grader suppresses a `low` one but re-surfaces a `high` one.
  const { data: rejections } = await admin.from("customer_link_rejections")
    .select("rejected_customer_id").eq("customer_id", customerId);
  const rejectedIds = new Set((rejections || []).map(r => r.rejected_customer_id));

  // Address corroboration + confidence grading + rejection semantics live in the pure grader
  // (unit-pinned in account-matching.test.ts).
  const candidates: CandidateInput[] = candidateIds.map((id) => {
    const entry = byId.get(id)!;
    return {
      id,
      email: entry.row.email,
      last_name: entry.row.last_name,
      address1: entry.row.default_address?.address1,
      zip: entry.row.default_address?.zip,
      signals: Array.from(entry.signals),
    };
  });
  const src = customer.default_address as Record<string, unknown> | null;
  return gradeUnlinkedCandidates(
    { last_name: customer.last_name, address1: src?.address1, zip: src?.zip },
    candidates,
    linkedIds,
    rejectedIds,
  );
}

/** True when the customer has at least one HIGH-confidence unlinked sibling — the signal Sol/June
 *  act on (propose a link before answering "no such account / no such charge"). */
export async function hasHighConfidenceUnlinkedMatch(
  workspaceId: string,
  customerId: string,
  adminClient?: Admin,
): Promise<boolean> {
  const matches = await findUnlinkedMatches(workspaceId, customerId, adminClient);
  return matches.some((m) => m.confidence === "high");
}
