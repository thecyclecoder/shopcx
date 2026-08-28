/**
 * cold-scaler-graduate-heartbeat — Phase 3 of
 * [[../../../docs/brain/specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]].
 *
 * The deepest cause of the 2026-07-27 incident was not ASC removal. It was that
 * an autonomous rail could exist for weeks, never fire once, and look identical
 * to a healthy rail that simply had no work to do. This module makes an
 * unexercised cold-scaler rail VISIBLE as unexercised — by reading the durable
 * activity ledger the Phase-1 graduate flow already writes
 * (`cold_scaler_graduated` on success, `cold_scaler_graduate_skipped` on any
 * skip) and turning it into (a) a per-cohort line the Growth Director digest
 * carries alongside the promote/kill recommendations, and (b) a deduped CEO
 * card when a cohort has an ELIGIBLE crowned winner and NO successful graduate
 * inside a bounded window.
 *
 * The eligibility gate is precise on purpose: an active cohort with NO
 * crowned-but-not-graduated winner is a HEALTHY quiet rail (nothing to
 * graduate ⇒ nothing to alert on). Alerting on it would train the CEO to
 * ignore the signal — which is the exact failure mode Phase 3 exists to
 * prevent.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";
import { listActiveColdScalerCohorts } from "./cold-scaler-cohort";

type Admin = ReturnType<typeof createAdminClient>;

/** The bounded window (ms) — a cohort with an eligible crowned winner and NO
 * successful graduate inside this window escalates. Seven days matches the
 * `COLD_SCALER_MIN_AGE_DAYS_BEFORE_PAUSE` grace elsewhere in the rail: a scaler
 * that has never received a graduate in a full week is silently dead. */
export const GRADUATE_STALL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Deep link the CEO card surfaces on. */
const HEARTBEAT_ESCALATION_DEEP_LINK = "/dashboard/marketing/ads";

/** Owner function — Growth owns the cold-scaler rail. */
const GROWTH_DIRECTOR_FUNCTION = "growth";

/** The spec slug stamped on every audit row this module writes. */
export const GRADUATE_HEARTBEAT_SPEC_SLUG =
  "bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently";

/** Per-cohort snapshot the digest surface + escalation predicate both read. */
export interface CohortGraduateHeartbeat {
  cohortId: string;
  metaAdAccountId: string | null;
  productId: string | null;
  scalerMetaCampaignId: string | null;
  /** ISO timestamp of the most recent `cold_scaler_graduated` row for this
   * cohort, or null when the cohort has never graduated a winner. */
  lastGraduatedAt: string | null;
  /** ISO timestamp of the most recent skip row (any `skip_reason`), or null. */
  lastSkippedAt: string | null;
  /** The `skip_reason` from the most recent skip row, or null. */
  lastSkipReason: string | null;
  /** Count of crown-marker rows for the cohort's (workspace, account, product)
   * scope that are NOT yet graduated (`graduated_at IS NULL`). Zero means the
   * cohort has nothing to graduate — the quiet-healthy case. */
  eligibleWinnerCount: number;
}

interface DirectorActivityRow {
  action_kind: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Read the latest `cold_scaler_graduated` / `cold_scaler_graduate_skipped`
 * rows for a workspace and roll them up per cohort. Bounded by
 * `sinceMs` (default: `nowMs - GRADUATE_STALL_WINDOW_MS`) so the read is
 * cheap even for a busy workspace.
 */
export async function readRecentGraduateActivityByCohort(
  admin: Admin,
  args: { workspaceId: string; sinceIso: string },
): Promise<Map<string, { lastGraduatedAt: string | null; lastSkippedAt: string | null; lastSkipReason: string | null }>> {
  const out = new Map<
    string,
    { lastGraduatedAt: string | null; lastSkippedAt: string | null; lastSkipReason: string | null }
  >();
  const { data } = await admin
    .from("director_activity")
    .select("action_kind, created_at, metadata")
    .eq("workspace_id", args.workspaceId)
    .in("action_kind", ["cold_scaler_graduated", "cold_scaler_graduate_skipped"])
    .gte("created_at", args.sinceIso)
    .order("created_at", { ascending: false });
  for (const r of (data ?? []) as DirectorActivityRow[]) {
    const cohortId = (r.metadata as Record<string, unknown> | null)?.["cohort_id"];
    if (typeof cohortId !== "string" || !cohortId) continue;
    const entry = out.get(cohortId) ?? {
      lastGraduatedAt: null as string | null,
      lastSkippedAt: null as string | null,
      lastSkipReason: null as string | null,
    };
    if (r.action_kind === "cold_scaler_graduated" && !entry.lastGraduatedAt) {
      entry.lastGraduatedAt = r.created_at;
    } else if (r.action_kind === "cold_scaler_graduate_skipped" && !entry.lastSkippedAt) {
      entry.lastSkippedAt = r.created_at;
      const reason = (r.metadata as Record<string, unknown> | null)?.["skip_reason"];
      entry.lastSkipReason = typeof reason === "string" ? reason : null;
    }
    out.set(cohortId, entry);
  }
  return out;
}

/**
 * Count the eligible crowned winners under each cohort's scope
 * `(workspace, meta_ad_account, product)`. An "eligible" winner is a crown row
 * with a null `graduated_at` AND a null `revoked_at` — the crown fact was captured, no graduate
 * flow has landed it in the scaler, AND it still qualifies under the active policy.
 *
 * ⭐ The `revoked_at` half was missing (CEO 2026-08-28). Counting only `graduated_at IS NULL`
 * treats a RETIRED crown as pending work: on 2026-08-25 all five crowns were revoked (the
 * crown bar moved 8→15 purchases plus a confidence bound, so none still qualified), and three
 * days later this counter was still raising CEO cards claiming Superfood Tabs had "3 crowned
 * winners but no graduate" and Zen Relax "2". Genuine pending work in both: ZERO. A stall card
 * for work that does not exist trains the reader to ignore stall cards, which is worse than
 * having none — the whole point of the escalation is that it means something.
 *
 * Note `revoked_at` is deliberately NOT `exploit_exhausted`: an exhausted winner is one whose
 * CLONES stopped producing hits, and it may still deserve to graduate. Only revocation means
 * "this is no longer a winner". Returns a map keyed by cohort id.
 */
export async function countEligibleCrownedWinnersByCohort(
  admin: Admin,
  args: { workspaceId: string; cohortScopes: Array<{ cohortId: string; metaAdAccountId: string | null; productId: string | null }> },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!args.cohortScopes.length) return out;
  const { data } = await admin
    .from("media_buyer_crowned_winners")
    .select("meta_ad_account_id, product_id, graduated_at, revoked_at")
    .eq("workspace_id", args.workspaceId)
    .is("graduated_at", null)
    .is("revoked_at", null);
  const rows = (data ?? []) as Array<{
    meta_ad_account_id: string | null;
    product_id: string | null;
    graduated_at: string | null;
    revoked_at: string | null;
  }>;
  for (const scope of args.cohortScopes) {
    const count = rows.filter(
      (r) => r.meta_ad_account_id === scope.metaAdAccountId && r.product_id === scope.productId,
    ).length;
    out.set(scope.cohortId, count);
  }
  return out;
}

/**
 * Compute per-cohort graduate heartbeats for every active cold-scaler cohort
 * on the workspace × meta ad account. Pure composition on top of the two
 * readers above.
 */
export async function computeCohortGraduateHeartbeats(
  admin: Admin,
  args: { workspaceId: string; metaAdAccountId: string | null; nowMs?: number },
): Promise<CohortGraduateHeartbeat[]> {
  const nowMs = args.nowMs ?? Date.now();
  const cohorts = await listActiveColdScalerCohorts(admin, {
    workspaceId: args.workspaceId,
    metaAdAccountId: args.metaAdAccountId,
  });
  if (!cohorts.length) return [];
  const sinceIso = new Date(nowMs - GRADUATE_STALL_WINDOW_MS).toISOString();
  const activityByCohort = await readRecentGraduateActivityByCohort(admin, {
    workspaceId: args.workspaceId,
    sinceIso,
  });
  const eligibleByCohort = await countEligibleCrownedWinnersByCohort(admin, {
    workspaceId: args.workspaceId,
    cohortScopes: cohorts.map((c) => ({
      cohortId: c.id,
      metaAdAccountId: c.metaAdAccountId,
      productId: c.productId,
    })),
  });
  return cohorts.map((c) => {
    const activity = activityByCohort.get(c.id);
    return {
      cohortId: c.id,
      metaAdAccountId: c.metaAdAccountId,
      productId: c.productId,
      scalerMetaCampaignId: c.scalerMetaCampaignId,
      lastGraduatedAt: activity?.lastGraduatedAt ?? null,
      lastSkippedAt: activity?.lastSkippedAt ?? null,
      lastSkipReason: activity?.lastSkipReason ?? null,
      eligibleWinnerCount: eligibleByCohort.get(c.id) ?? 0,
    };
  });
}

/**
 * Pure formatter — the plain-text lines that go into the Growth Director
 * digest under a "Cold-scaler graduates" heading. Returns an empty array when
 * there are no active cohorts (so `composeDigest` can skip the header
 * altogether).
 */
export function formatCohortGraduateHeartbeatsForDigest(
  heartbeats: readonly CohortGraduateHeartbeat[],
  nowMs: number = Date.now(),
): string[] {
  if (!heartbeats.length) return [];
  const lines: string[] = [];
  for (const h of heartbeats) {
    const idShort = h.cohortId.slice(0, 8);
    const lastGrad = h.lastGraduatedAt
      ? formatRelativeAge(h.lastGraduatedAt, nowMs)
      : "never";
    const eligibleTxt = h.eligibleWinnerCount === 1
      ? "1 eligible winner"
      : `${h.eligibleWinnerCount} eligible winners`;
    const suffix =
      h.eligibleWinnerCount > 0 && !h.lastGraduatedAt && h.lastSkipReason
        ? ` (last skip: ${h.lastSkipReason})`
        : "";
    lines.push(`   ↳ cohort ${idShort} — last graduated ${lastGrad}, ${eligibleTxt}${suffix}`);
  }
  return lines;
}

function formatRelativeAge(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const ageDays = Math.max(0, Math.floor((nowMs - t) / (24 * 60 * 60 * 1000)));
  if (ageDays === 0) return "today";
  if (ageDays === 1) return "1d ago";
  return `${ageDays}d ago`;
}

/**
 * The escalation predicate: an active cohort is STALLED when
 *   (a) it has at least one eligible crowned winner (crown captured, not
 *       graduated), AND
 *   (b) no successful graduate row exists inside the bounded window.
 *
 * A cohort with zero eligible winners is a HEALTHY QUIET rail; a cohort
 * that graduated inside the window is proving itself alive. Neither
 * escalates — that would be noise (the exact anti-signal the spec
 * warns about).
 */
export function isCohortGraduateStalled(h: CohortGraduateHeartbeat): boolean {
  return h.eligibleWinnerCount > 0 && !h.lastGraduatedAt;
}

export interface EscalateColdScalerGraduateStallInput {
  workspaceId: string;
  heartbeat: CohortGraduateHeartbeat;
  /** Override "now" for deterministic dedupe in tests. */
  nowMs?: number;
}

export interface EscalateColdScalerGraduateStallResult {
  emitted: boolean;
  reason?: string;
}

/**
 * Raise a deduped CEO card for one stalled cohort. Idempotent per
 * (workspace, cohort, UTC day) — the dedupe key is
 * `cold_scaler_graduate_stall:{workspace}:{cohort}:{yyyy-mm-dd}`. The
 * confirming predicate is a `metadata->>dedupe_key` SELECT with a workspace +
 * type filter, so a second call the same day short-circuits before the
 * insert. Best-effort — a DB write failure logs and returns `{emitted:false}`
 * rather than throwing (an escalation SDK that CAN throw would drop the
 * caller into a nested error path just as the CEO card was supposed to make
 * things easier).
 */
export async function escalateColdScalerGraduateStall(
  admin: Admin,
  input: EscalateColdScalerGraduateStallInput,
): Promise<EscalateColdScalerGraduateStallResult> {
  const h = input.heartbeat;
  if (!isCohortGraduateStalled(h)) {
    return { emitted: false, reason: "not stalled — no eligible winners or graduate is fresh" };
  }
  const day = new Date(input.nowMs ?? Date.now()).toISOString().slice(0, 10);
  const dedupeKey = `cold_scaler_graduate_stall:${input.workspaceId}:${h.cohortId}:${day}`;

  try {
    const { data: prior } = await admin
      .from("dashboard_notifications")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .eq("type", APPROVAL_REQUEST_TYPE)
      .eq("metadata->>dedupe_key", dedupeKey)
      .limit(1);
    if ((prior ?? []).length > 0) return { emitted: false, reason: "same-day duplicate" };
  } catch (err) {
    console.warn("[cold-scaler-graduate-heartbeat] prior-card lookup failed (skipping card)", { err });
    return { emitted: false, reason: "prior-card lookup failed" };
  }

  const idShort = h.cohortId.slice(0, 8);
  const eligibleTxt = h.eligibleWinnerCount === 1
    ? "1 crowned winner"
    : `${h.eligibleWinnerCount} crowned winners`;
  const skipHint = h.lastSkipReason ? ` The last graduate attempt skipped with reason "${h.lastSkipReason}".` : "";
  const title = `Cold-scaler cohort ${idShort} has ${eligibleTxt} but no graduate in the last 7 days`.slice(0, 200);
  const body = (
    `Cohort ${h.cohortId} is active and has ${eligibleTxt} whose crown was captured but never landed in the scaler campaign. ` +
    `No successful \`cold_scaler_graduated\` \`director_activity\` row has been recorded inside the ${Math.round(
      GRADUATE_STALL_WINDOW_MS / (24 * 60 * 60 * 1000),
    )}-day window.${skipHint}\n\n` +
    `This is the condition that was silently true for the entire life of the Zen Relax cohort before the 2026-07-27 incident: ` +
    `an autonomous rail with work to do but no successful run. Check the arming gate authorization for the cohort, or the ` +
    `last skip reason above, then either clear the block or retire the cohort. ` +
    `Same-day repeats collapse to this one card by dedupe key.`
  ).slice(0, 4000);

  try {
    const { error } = await admin.from("dashboard_notifications").insert({
      workspace_id: input.workspaceId,
      type: APPROVAL_REQUEST_TYPE,
      title,
      body,
      link: HEARTBEAT_ESCALATION_DEEP_LINK,
      metadata: {
        routed_to_function: "ceo",
        escalated_by_director: GROWTH_DIRECTOR_FUNCTION,
        escalation_kind: "cold_scaler_graduate_stall",
        cohort_id: h.cohortId,
        meta_ad_account_id: h.metaAdAccountId,
        product_id: h.productId,
        scaler_meta_campaign_id: h.scalerMetaCampaignId,
        eligible_winner_count: h.eligibleWinnerCount,
        last_graduated_at: h.lastGraduatedAt,
        last_skipped_at: h.lastSkippedAt,
        last_skip_reason: h.lastSkipReason,
        window_days: Math.round(GRADUATE_STALL_WINDOW_MS / (24 * 60 * 60 * 1000)),
        dedupe_key: dedupeKey,
        approve_action_id: null,
      },
      read: false,
      dismissed: false,
    });
    if (error) {
      console.warn("[cold-scaler-graduate-heartbeat] insert failed", { error, dedupeKey });
      return { emitted: false, reason: "insert failed" };
    }
    return { emitted: true };
  } catch (err) {
    console.warn("[cold-scaler-graduate-heartbeat] insert threw", { err, dedupeKey });
    return { emitted: false, reason: "insert threw" };
  }
}

/**
 * Run the stall check for every active cohort on the workspace × meta ad
 * account: computes heartbeats, then raises one CEO card per stalled cohort.
 * Returns the heartbeats + the count of cards emitted so the caller can log
 * both. Best-effort — a failure inside one cohort's escalation does not
 * short-circuit the others.
 */
export async function runColdScalerGraduateStallCheck(
  admin: Admin,
  args: { workspaceId: string; metaAdAccountId: string | null; nowMs?: number },
): Promise<{ heartbeats: CohortGraduateHeartbeat[]; emitted: number }> {
  const nowMs = args.nowMs ?? Date.now();
  const heartbeats = await computeCohortGraduateHeartbeats(admin, {
    workspaceId: args.workspaceId,
    metaAdAccountId: args.metaAdAccountId,
    nowMs,
  });
  let emitted = 0;
  for (const h of heartbeats) {
    if (!isCohortGraduateStalled(h)) continue;
    const r = await escalateColdScalerGraduateStall(admin, {
      workspaceId: args.workspaceId,
      heartbeat: h,
      nowMs,
    });
    if (r.emitted) emitted += 1;
  }
  return { heartbeats, emitted };
}
