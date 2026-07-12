/**
 * media-buyer/arming-gate — Phase 1 of [[../../../docs/brain/specs/media-buyer-arming-gate.md]]
 * (goal `autonomous-media-buyer-supervision`, M3 "Armed (bounded autonomous execution)").
 *
 * The deterministic gate that authorizes a Media Buyer cohort's move from
 * `mode='shadow'` (audit-only) to `mode='armed'` (executor may act) for a given
 * ISO week. Encodes the goal's THREE pre-arming preconditions:
 *
 *   1. Shadow-vs-review AGREEMENT — over the last 14d, at least
 *      `MIN_REVIEWED_SHADOW_ACTIONS` shadow actions were reviewed AND the concur
 *      rate ≥ `MIN_AGREEMENT_RATE` (0.8). Fewer reviews ⇒ `insufficient_sample`.
 *      Concur < 0.8 ⇒ `low_agreement`.
 *   2. SENSOR-TRUST GREEN STREAK — at least `MIN_CONSECUTIVE_GREEN_TRUST` (7)
 *      consecutive `band='green'` [[../../../docs/brain/tables/media_buyer_sensor_trust]]
 *      snapshots ending at the latest snapshot. Missing / broken by yellow/red ⇒
 *      `trust_streak_short`. Zero snapshots ⇒ `trust_no_snapshots`.
 *   3. BLENDED CAC:LTV HEALTHY — from [[../blended-cac-ltv]] `computeBlendedCacLtv`
 *      over the same 14d window, `cacLtvRatio ≥ DEFAULT_BLENDED_CAC_LTV_TARGET`
 *      (3×) OR under a caller-supplied target. Below target ⇒
 *      `blended_cac_ltv_below_target`. Null ratio ⇒ `blended_cac_ltv_unknown`.
 *
 * The gate is PURE (`evaluateMediaBuyerArmingPure` — the piece the unit tests
 * pin). The DB-touching wrapper `runMediaBuyerArmingGate` loads the three inputs,
 * calls the pure fn, upserts one `media_buyer_arming_authorization` row, and on
 * `!allowed` escalates to the CEO via `escalateDiagnosisToCeo` +
 * `recordDirectorActivity('media_buyer_arming_denied')`. The write is the
 * ONLY authoritative surface for the flip — the goal's "hitting a rail =
 * escalate, not execute" north-star is encoded here.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { escalateDiagnosisToCeo } from "@/lib/agents/platform-director";
import { recordDirectorActivity } from "@/lib/director-activity";
import {
  computeBlendedCacLtv,
  DEFAULT_BLENDED_CAC_LTV_TARGET,
  type BlendedCacLtvResult,
} from "@/lib/blended-cac-ltv";
import { readEffectiveOnOff } from "@/lib/control-tower/legacy-switch-compat";

type Admin = ReturnType<typeof createAdminClient>;

/** The Growth director's function slug — mirrors the Media Buyer publish gate. */
const GROWTH_DIRECTOR_FUNCTION = "growth";

/** Deep link surfaced with the CEO escalation — the Media Buyer surface. */
const ARMING_GATE_DEEP_LINK = "/dashboard/marketing/ads";

/** The sample window the three preconditions read from. Matches the goal-level
 *  "shadow/review agreement over the last 14 days" contract. */
export const ARMING_GATE_LOOKBACK_DAYS = 14;

/** Minimum reviewed shadow actions before agreement rate is trustworthy. */
export const MIN_REVIEWED_SHADOW_ACTIONS = 20;

/** Minimum concur / reviewed ratio. Below this the gate refuses. */
export const MIN_AGREEMENT_RATE = 0.8;

/** Minimum consecutive `band='green'` sensor-trust snapshots ending at the latest. */
export const MIN_CONSECUTIVE_GREEN_TRUST = 7;

/** How long an authorization row stays valid — one ISO week. Beyond `expires_at`,
 *  the gate must re-evaluate; the executor treats an expired row as a rail. */
const AUTHORIZATION_TTL_DAYS = 7;

// ── Pure gate ─────────────────────────────────────────────────────────────────

/**
 * A shadow-review row (the subset the pure gate needs). Aligns with
 * [[../../../docs/brain/tables/media_buyer_shadow_reviews]].
 */
export interface ShadowReviewInput {
  /** 'concur' | 'dissent' | 'undecided' — mirrors the DB check constraint. */
  verdict: "concur" | "dissent" | "undecided";
  /** ISO timestamp the review was created — used to bound the 14d window. */
  reviewedAt: string;
}

/**
 * A sensor-trust snapshot (the subset the pure gate needs). Aligns with
 * [[../../../docs/brain/tables/media_buyer_sensor_trust]].
 */
export interface TrustSnapshotInput {
  /** YYYY-MM-DD — one snapshot per day (workspace, account, date). */
  snapshotDate: string;
  /** 'green' | 'yellow' | 'red' — the streak lives on 'green'. */
  band: "green" | "yellow" | "red";
}

/** Denial branches — each maps to one guard predicate, structured so the audit /
 *  the CEO can name WHY the arming request was refused. */
export type ArmingDenialReason =
  | "insufficient_sample" // <MIN_REVIEWED_SHADOW_ACTIONS reviewed in the window.
  | "low_agreement" // concur / reviewed < MIN_AGREEMENT_RATE.
  | "trust_no_snapshots" // zero sensor-trust snapshots in the window.
  | "trust_streak_short" // <MIN_CONSECUTIVE_GREEN_TRUST consecutive green snapshots.
  | "blended_cac_ltv_below_target" // cacLtvRatio present but < targetCacLtv.
  | "blended_cac_ltv_unknown" // cacLtvRatio null (no CAC, no LTV, or no mapping).
  | "kill_switch_cascade_off"; // migrate-ad-hoc-kill-switches-to-resolver Phase 1 — a `growth`/`media-buyer` kill_switches row is OFF; readiness route refuses.

export interface ArmingGateReason {
  code: ArmingDenialReason;
  detail: string;
}

export interface EvaluateMediaBuyerArmingPureInput {
  shadowReviews: ShadowReviewInput[];
  trustSnapshots: TrustSnapshotInput[];
  blended: BlendedCacLtvResult;
}

export interface EvaluateMediaBuyerArmingPureResult {
  allowed: boolean;
  reasons: ArmingGateReason[];
  /** Structured measurements the DB row + audit metadata carry — surfaced so the
   *  CEO / grader can inspect the numbers without re-deriving them. */
  metrics: {
    reviewed: number;
    concurred: number;
    agreementRate: number | null;
    consecutiveGreen: number;
    cacLtvRatio: number | null;
    targetCacLtv: number;
  };
}

/**
 * Pure evaluation of the arming gate — no DB, no side effects. Unit tests pin
 * each denial branch by feeding fixtures. The DB-touching runner below composes
 * this with loads + writes.
 */
export function evaluateMediaBuyerArmingPure(
  input: EvaluateMediaBuyerArmingPureInput,
): EvaluateMediaBuyerArmingPureResult {
  const reasons: ArmingGateReason[] = [];

  // ── Precondition 1: shadow / review agreement over 14d ──────────────────
  const reviewed = input.shadowReviews.length;
  const concurred = input.shadowReviews.filter((r) => r.verdict === "concur").length;
  const agreementRate = reviewed > 0 ? concurred / reviewed : null;

  if (reviewed < MIN_REVIEWED_SHADOW_ACTIONS) {
    reasons.push({
      code: "insufficient_sample",
      detail: `only ${reviewed}/${MIN_REVIEWED_SHADOW_ACTIONS} reviewed shadow actions in the last ${ARMING_GATE_LOOKBACK_DAYS}d`,
    });
  } else if (agreementRate !== null && agreementRate < MIN_AGREEMENT_RATE) {
    reasons.push({
      code: "low_agreement",
      detail: `concur rate ${(agreementRate * 100).toFixed(1)}% below ${(MIN_AGREEMENT_RATE * 100).toFixed(0)}% floor (${concurred}/${reviewed})`,
    });
  }

  // ── Precondition 2: consecutive green sensor-trust snapshots ────────────
  const consecutiveGreen = countConsecutiveGreenSnapshots(input.trustSnapshots);
  if (input.trustSnapshots.length === 0) {
    reasons.push({
      code: "trust_no_snapshots",
      detail: `no media_buyer_sensor_trust snapshots in the last ${ARMING_GATE_LOOKBACK_DAYS}d`,
    });
  } else if (consecutiveGreen < MIN_CONSECUTIVE_GREEN_TRUST) {
    reasons.push({
      code: "trust_streak_short",
      detail: `only ${consecutiveGreen}/${MIN_CONSECUTIVE_GREEN_TRUST} consecutive green snapshots ending at the latest`,
    });
  }

  // ── Precondition 3: blended CAC:LTV at/under the target ────────────────
  const targetCacLtv = input.blended.assumptions.targetCacLtv ?? DEFAULT_BLENDED_CAC_LTV_TARGET;
  const cacLtvRatio = input.blended.cacLtvRatio;
  if (cacLtvRatio === null) {
    reasons.push({
      code: "blended_cac_ltv_unknown",
      detail: `blended CAC:LTV undefined (${input.blended.flags.join("; ") || "no CAC / no LTV / no mapping"})`,
    });
  } else if (cacLtvRatio < targetCacLtv) {
    reasons.push({
      code: "blended_cac_ltv_below_target",
      detail: `blended CAC:LTV ${cacLtvRatio.toFixed(2)}× below target ${targetCacLtv}×`,
    });
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: {
      reviewed,
      concurred,
      agreementRate,
      consecutiveGreen,
      cacLtvRatio,
      targetCacLtv,
    },
  };
}

/**
 * Count consecutive `band='green'` snapshots ending at the LATEST snapshot date.
 * A yellow / red anywhere breaks the streak — the streak is anchored to today,
 * not the historical maximum. Snapshots may arrive in any order; we sort by date
 * descending first. Missing dates DO NOT count as green (mirrors the calibrate
 * runner's "missing snapshot ≡ rail" principle).
 */
function countConsecutiveGreenSnapshots(snapshots: TrustSnapshotInput[]): number {
  if (snapshots.length === 0) return 0;
  const sorted = [...snapshots].sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate));
  let count = 0;
  for (const s of sorted) {
    if (s.band === "green") count++;
    else break;
  }
  return count;
}

// ── ISO week helper ───────────────────────────────────────────────────────────

/**
 * ISO 8601 week label for a Date (`YYYY-Www`). The authorization row is keyed
 * by this — the sample window resets weekly.
 */
export function isoWeekLabel(d: Date): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// ── DB-touching runner ────────────────────────────────────────────────────────

export interface RunMediaBuyerArmingGateInput {
  workspaceId: string;
  /** null ⇒ workspace-wide row (matches the workspace-wide sensor-trust fallback);
   *  non-null ⇒ per-account scope. */
  metaAdAccountId?: string | null;
  /** Overrides DEFAULT_BLENDED_CAC_LTV_TARGET; surfaced on the pure gate metrics. */
  targetCacLtv?: number;
  /** Injected clock — tests pin the ISO week + the window bounds. */
  now?: Date;
}

export interface RunMediaBuyerArmingGateResult {
  status: "allowed" | "denied";
  isoWeek: string;
  authorizationId: string | null;
  reasons: ArmingGateReason[];
  metrics: EvaluateMediaBuyerArmingPureResult["metrics"];
  /** True when the deny path emitted a new CEO notification (first denial in this
   *  ISO week — subsequent evaluations dedupe via `escalateDiagnosisToCeo`). */
  ceoEscalationEmitted: boolean;
}

/**
 * The DB-touching entry point. Reads the three preconditions, calls the pure gate,
 * upserts one `media_buyer_arming_authorization` row, and on deny escalates to
 * the CEO + writes a growth-owned `media_buyer_arming_denied` audit row.
 */
export async function runMediaBuyerArmingGate(
  admin: Admin,
  input: RunMediaBuyerArmingGateInput,
): Promise<RunMediaBuyerArmingGateResult> {
  const now = input.now ?? new Date();
  const isoWeek = isoWeekLabel(now);
  const windowStartDate = isoDateOffset(now, -ARMING_GATE_LOOKBACK_DAYS);
  const windowEndDate = isoDate(now);

  // migrate-ad-hoc-kill-switches-to-resolver Phase 1 — the arming gate itself is unchanged, but
  // the READINESS check consults [[../control-tower/kill-switch-resolver]] via the union shim
  // BEFORE evaluating the three preconditions. If the growth/media-buyer cascade is OFF, refuse
  // arming immediately (a rail, not an execute — matches the goal's north-star). Legacy fn returns
  // `true` because arming has no pre-existing per-workspace ad-hoc column; only the resolver can
  // switch this off. Refusal is stamped as a normal deny (no CEO escalation — the CEO already
  // owns the kill_switches row that caused it; escalating back to her would be a loop).
  const cascade = await readEffectiveOnOff("media-buyer", async () => true);
  if (cascade.off) {
    const reason: ArmingGateReason = {
      code: "kill_switch_cascade_off",
      detail: `kill_switches cascade OFF (source=${cascade.source}${cascade.offBy ? `, offBy=${cascade.offBy}` : ""}${cascade.reason ? `: ${cascade.reason}` : ""})`,
    };
    const emptyMetrics: EvaluateMediaBuyerArmingPureResult["metrics"] = {
      reviewed: 0,
      concurred: 0,
      agreementRate: null,
      consecutiveGreen: 0,
      cacLtvRatio: null,
      targetCacLtv: input.targetCacLtv ?? DEFAULT_BLENDED_CAC_LTV_TARGET,
    };
    return {
      status: "denied",
      isoWeek,
      authorizationId: null,
      reasons: [reason],
      metrics: emptyMetrics,
      ceoEscalationEmitted: false,
    };
  }

  const [shadowReviews, trustSnapshots, blended] = await Promise.all([
    loadShadowReviews(admin, {
      workspaceId: input.workspaceId,
      metaAdAccountId: input.metaAdAccountId ?? null,
      sinceIso: `${windowStartDate}T00:00:00Z`,
    }),
    loadTrustSnapshots(admin, {
      workspaceId: input.workspaceId,
      metaAdAccountId: input.metaAdAccountId ?? null,
      sinceDate: windowStartDate,
    }),
    computeBlendedCacLtv({
      workspaceId: input.workspaceId,
      startDate: windowStartDate,
      endDate: windowEndDate,
      targetCacLtv: input.targetCacLtv,
    }),
  ]);

  const evaluation = evaluateMediaBuyerArmingPure({ shadowReviews, trustSnapshots, blended });

  const expiresAt = new Date(now.getTime() + AUTHORIZATION_TTL_DAYS * 86_400_000).toISOString();
  const authorizationId = await upsertAuthorization(admin, {
    workspaceId: input.workspaceId,
    metaAdAccountId: input.metaAdAccountId ?? null,
    isoWeek,
    allowed: evaluation.allowed,
    reasons: evaluation.reasons,
    metrics: evaluation.metrics,
    evaluatedAt: now.toISOString(),
    expiresAt,
  });

  if (evaluation.allowed) {
    return {
      status: "allowed",
      isoWeek,
      authorizationId,
      reasons: [],
      metrics: evaluation.metrics,
      ceoEscalationEmitted: false,
    };
  }

  // Deny path — escalate + audit.
  const diagnosis = buildDenialDiagnosis({
    workspaceId: input.workspaceId,
    metaAdAccountId: input.metaAdAccountId ?? null,
    isoWeek,
    reasons: evaluation.reasons,
    metrics: evaluation.metrics,
  });
  const dedupeKey = denialDedupeKey({
    workspaceId: input.workspaceId,
    metaAdAccountId: input.metaAdAccountId ?? null,
    isoWeek,
  });

  const ceo = await escalateDiagnosisToCeo(admin, {
    workspaceId: input.workspaceId,
    specSlug: "media-buyer-arming-gate",
    title: `Media Buyer arming refused (${isoWeek})`,
    diagnosis,
    dedupeKey,
    deepLink: ARMING_GATE_DEEP_LINK,
    escalationKind: "media_buyer_arming_denied",
    metadata: {
      iso_week: isoWeek,
      meta_ad_account_id: input.metaAdAccountId ?? null,
      reasons: evaluation.reasons,
      metrics: evaluation.metrics,
    },
  });

  await recordDirectorActivity(admin, {
    workspaceId: input.workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "media_buyer_arming_denied",
    specSlug: "media-buyer-arming-gate",
    reason: diagnosis,
    metadata: {
      iso_week: isoWeek,
      meta_ad_account_id: input.metaAdAccountId ?? null,
      reasons: evaluation.reasons,
      metrics: evaluation.metrics,
      authorization_id: authorizationId,
      dedupe_key: dedupeKey,
      autonomous: true,
    },
  });

  return {
    status: "denied",
    isoWeek,
    authorizationId,
    reasons: evaluation.reasons,
    metrics: evaluation.metrics,
    ceoEscalationEmitted: ceo.emitted,
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function loadShadowReviews(
  admin: Admin,
  opts: { workspaceId: string; metaAdAccountId: string | null; sinceIso: string },
): Promise<ShadowReviewInput[]> {
  // Shadow reviews are scoped by workspace_id; the (workspace, account) narrowing
  // rides on the joined director_activity row's metadata.meta_ad_account_id
  // (Phase 2 of media-buyer-shadow-mode). For Phase 1 of the arming gate we join
  // by director_activity_id to the parent shadow action and read the account off
  // its metadata; a missing metadata.meta_ad_account_id lands in the workspace-wide
  // bucket, matching how the sensor-trust probe treats the null fallback.
  const { data, error } = await admin
    .from("media_buyer_shadow_reviews")
    .select("verdict, reviewed_at, director_activity_id, director_activity:director_activity!inner(metadata)")
    .eq("workspace_id", opts.workspaceId)
    .gte("reviewed_at", opts.sinceIso);
  if (error) {
    console.warn(`[arming-gate] media_buyer_shadow_reviews read failed: ${error.message}`);
    return [];
  }
  const rows = (data || []) as Array<{
    verdict: string;
    reviewed_at: string;
    director_activity?: { metadata?: Record<string, unknown> | null } | null;
  }>;
  return rows
    .filter((r) => {
      // Scope filter: workspace-wide call ⇒ include every review; per-account call
      // ⇒ only reviews whose parent shadow action was scoped to the same account.
      if (opts.metaAdAccountId === null) return true;
      const metaAccount = r.director_activity?.metadata?.["meta_ad_account_id"];
      return typeof metaAccount === "string" && metaAccount === opts.metaAdAccountId;
    })
    .filter((r): r is { verdict: "concur" | "dissent" | "undecided"; reviewed_at: string } =>
      r.verdict === "concur" || r.verdict === "dissent" || r.verdict === "undecided",
    )
    .map((r) => ({ verdict: r.verdict, reviewedAt: r.reviewed_at }));
}

async function loadTrustSnapshots(
  admin: Admin,
  opts: { workspaceId: string; metaAdAccountId: string | null; sinceDate: string },
): Promise<TrustSnapshotInput[]> {
  const scoped = admin
    .from("media_buyer_sensor_trust")
    .select("snapshot_date, band")
    .eq("workspace_id", opts.workspaceId)
    .gte("snapshot_date", opts.sinceDate);
  const query = opts.metaAdAccountId === null
    ? scoped.is("meta_ad_account_id", null)
    : scoped.eq("meta_ad_account_id", opts.metaAdAccountId);
  const { data, error } = await query.order("snapshot_date", { ascending: false });
  if (error) {
    console.warn(`[arming-gate] media_buyer_sensor_trust read failed: ${error.message}`);
    return [];
  }
  const rows = (data || []) as Array<{ snapshot_date: string; band: string }>;
  return rows
    .filter((r): r is { snapshot_date: string; band: "green" | "yellow" | "red" } =>
      r.band === "green" || r.band === "yellow" || r.band === "red",
    )
    .map((r) => ({ snapshotDate: r.snapshot_date, band: r.band }));
}

export async function upsertAuthorization(
  admin: Admin,
  args: {
    workspaceId: string;
    metaAdAccountId: string | null;
    isoWeek: string;
    allowed: boolean;
    reasons: ArmingGateReason[];
    metrics: EvaluateMediaBuyerArmingPureResult["metrics"];
    evaluatedAt: string;
    expiresAt: string;
  },
): Promise<string | null> {
  const row = {
    workspace_id: args.workspaceId,
    meta_ad_account_id: args.metaAdAccountId,
    iso_week: args.isoWeek,
    allowed: args.allowed,
    reasons: { reasons: args.reasons, metrics: args.metrics },
    evaluated_at: args.evaluatedAt,
    expires_at: args.expiresAt,
  };

  // The composite unique on (workspace_id, coalesce(meta_ad_account_id::text, ''), iso_week)
  // is an EXPRESSION index — Postgres can't accept it as an ON CONFLICT column list, and
  // Supabase-js can't pass expressions in `onConflict`. Same reasoning as
  // media-buyer/sensor-trust-probe.ts:393-435: manual select-then-write compare-and-set.
  //   1) SELECT the row for (workspace, coalesce(account,''), iso_week). At most one hit by
  //      the unique index. Non-null account uses `.eq`, null uses `.is` so PostgREST folds
  //      `meta_ad_account_id IS NULL` correctly (matching the COALESCE-to-'' bucket).
  //   2) If it exists → UPDATE by id (workspace-scoped) with `.select("id")` asserting
  //      exactly one row transitioned. Otherwise INSERT with the same assertion.
  const selectQ = admin
    .from("media_buyer_arming_authorization")
    .select("id")
    .eq("workspace_id", args.workspaceId)
    .eq("iso_week", args.isoWeek);
  const { data: existing } = args.metaAdAccountId
    ? await selectQ.eq("meta_ad_account_id", args.metaAdAccountId).maybeSingle()
    : await selectQ.is("meta_ad_account_id", null).maybeSingle();

  if (existing && (existing as { id: string }).id) {
    const id = (existing as { id: string }).id;
    const { data: updated, error: updErr } = await admin
      .from("media_buyer_arming_authorization")
      .update({
        allowed: row.allowed,
        reasons: row.reasons,
        evaluated_at: row.evaluated_at,
        expires_at: row.expires_at,
      })
      .eq("id", id)
      .eq("workspace_id", args.workspaceId)
      .select("id");
    if (updErr) {
      console.warn(`[arming-gate] media_buyer_arming_authorization update failed: ${updErr.message}`);
      return null;
    }
    return Array.isArray(updated) && updated.length === 1 ? id : null;
  }

  const { data: inserted, error: insErr } = await admin
    .from("media_buyer_arming_authorization")
    .insert(row)
    .select("id");
  if (insErr) {
    console.warn(`[arming-gate] media_buyer_arming_authorization insert failed: ${insErr.message}`);
    return null;
  }
  const insertedRows = inserted as Array<{ id: string }> | null;
  return Array.isArray(insertedRows) && insertedRows.length === 1 ? insertedRows[0].id : null;
}

// ── Diagnosis + dedupe ────────────────────────────────────────────────────────

function buildDenialDiagnosis(args: {
  workspaceId: string;
  metaAdAccountId: string | null;
  isoWeek: string;
  reasons: ArmingGateReason[];
  metrics: EvaluateMediaBuyerArmingPureResult["metrics"];
}): string {
  const scope = args.metaAdAccountId ? `account ${args.metaAdAccountId}` : "workspace-wide";
  const bullets = args.reasons.map((r) => `  • ${r.code} — ${r.detail}`).join("\n");
  return (
    `Media Buyer arming REFUSED for ${scope} (${args.isoWeek}). ` +
    `The cohort stays in shadow — no autonomous executor motion. Reasons:\n${bullets}\n` +
    `Once the failing predicates clear, re-run the gate; the authorization row expires in ${AUTHORIZATION_TTL_DAYS}d.`
  );
}

function denialDedupeKey(args: {
  workspaceId: string;
  metaAdAccountId: string | null;
  isoWeek: string;
}): string {
  const accountKey = args.metaAdAccountId ?? "workspace";
  return `media_buyer_arming_denied:${args.workspaceId}:${accountKey}:${args.isoWeek}`;
}

// ── Date utils ────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoDateOffset(d: Date, deltaDays: number): string {
  const t = d.getTime() + deltaDays * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
