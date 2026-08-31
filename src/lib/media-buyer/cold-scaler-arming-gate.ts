/**
 * media-buyer/cold-scaler-arming-gate — Phase 2 of
 * [[../../../docs/brain/specs/bianca-cold-scaler-arming-gate-shadow-to-armed.md]]
 * (Bianca goal M4 "Bounded, supervised cold scaler gated on Dahlia winner
 * supply"), with Precondition #1 rewritten by
 * [[../../../docs/brain/specs/cold-scaler-arming-decides-on-evidence-not-absence.md]]
 * Phase 3 to judge Bianca on GRADED OUTCOMES instead of shadow reviews she
 * can no longer produce.
 *
 * The SCALER-rail sibling of [[./arming-gate]]. That gate authorises the TEST
 * cohort's `mode='shadow' → 'armed'` flip; this one authorises the COLD
 * SCALER cohort's flip. Same three preconditions, same weekly ISO-week
 * row-per-authorization pattern — different table
 * ([[media_buyer_cold_scaler_arming_authorization]]), different scope key
 * (`cold_scaler_cohort_id` instead of the account-only pair), different
 * escalation kind (`cold_scaler_arming_denied`).
 *
 * The three preconditions:
 *   1. GRADED SCALE-ACTION PASS RATE — over the last 14d, at least
 *      `MIN_GRADED_SCALE_ACTIONS` scaling-judgement grades exist in
 *      [[media_buyer_action_grades]] scoped to the SCALE-vocabulary
 *      (`media_buyer_promoted_winner` + `media_buyer_replenished_test_cohort`),
 *      AND the fraction with `overall_grade >= SCALE_GRADE_PASS_THRESHOLD`
 *      is ≥ `MIN_SCALE_PASS_RATE`. Fewer ⇒ `insufficient_graded_scale_actions`.
 *      Below the bar ⇒ `scale_grade_below_bar`. The gate deliberately excludes
 *      KILL grades (`media_buyer_paused_loser`) — Bianca's kill skill is
 *      ~97% sound and her promote skill is ~36%; blending would let the
 *      strongest skill vouch for the weakest, which is exactly the
 *      supervision the gate is here to prevent.
 *   2. SENSOR-TRUST GREEN STREAK — at least `MIN_CONSECUTIVE_GREEN_TRUST`
 *      consecutive `band='green'` [[media_buyer_sensor_trust]] snapshots
 *      ending at the latest. Missing / broken ⇒ `trust_streak_short`. Zero
 *      snapshots ⇒ `trust_no_snapshots`.
 *   3. CAC:LTV HEALTHY — the scaler cohort's [[../blended-cac-ltv]]
 *      `cacLtvRatio` ≥ `DEFAULT_COLD_SCALER_CAC_LTV_TARGET` (3× — same as the
 *      blended floor; overridable). Below ⇒ `cac_ltv_below_target`. Null ⇒
 *      `cac_ltv_unknown`. Fed by the future
 *      `media_buyer_cold_scaler_cac_ltv_snapshot` sensor row when it lands
 *      (M4 spec #8); until then, the runner falls back to
 *      `computeBlendedCacLtv` for the same 14d window so the gate isn't
 *      blocked on the sensor spec's ship order.
 *
 * The gate is PURE (`evaluateColdScalerArmingPure` — the piece the unit
 * tests pin). The DB-touching wrapper `runColdScalerArmingGate` loads the
 * three inputs, calls the pure fn, upserts one
 * `media_buyer_cold_scaler_arming_authorization` row, and on `!allowed`
 * escalates to the CEO via `escalateDiagnosisToCeo` +
 * `recordDirectorActivity('cold_scaler_arming_denied')`. The write is the
 * ONLY authoritative surface for the flip — the Bianca goal's "own
 * shadow→armed arming authorization (human-vetoable)" M4 north-star is
 * encoded here.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { escalateDiagnosisToCeo } from "@/lib/agents/platform-director";
import { recordDirectorActivity } from "@/lib/director-activity";
import { computeBlendedCacLtv, DEFAULT_BLENDED_CAC_LTV_TARGET } from "@/lib/blended-cac-ltv";
import { readLatestColdScalerCacLtvSnapshot } from "./cold-scaler-cac-ltv-sensor";

type Admin = ReturnType<typeof createAdminClient>;

/** The Growth director's function slug — mirrors the sibling arming gate. */
const GROWTH_DIRECTOR_FUNCTION = "growth";

/** Deep link surfaced with the CEO escalation. */
const COLD_SCALER_ARMING_GATE_DEEP_LINK = "/dashboard/marketing/ads";

/** The spec slug this gate implements — surfaced on every director_activity
 *  row and every escalation card. */
const COLD_SCALER_SPEC_SLUG = "bianca-cold-scaler-arming-gate-shadow-to-armed";

/** The sample window the three preconditions read from — mirrors the sibling. */
export const ARMING_GATE_LOOKBACK_DAYS = 14;

/**
 * Minimum graded SCALE-vocabulary actions in the 14d window before the pass
 * rate is trustworthy. Kept at 20 — the same sample floor the retired
 * shadow-review branch used — so the gate's evidence threshold does not
 * shift with the input source. Below this ⇒ `insufficient_graded_scale_actions`.
 */
export const MIN_GRADED_SCALE_ACTIONS = 20;

/**
 * Minimum `passing / graded` ratio among SCALE-vocabulary grades in the 14d
 * window. A grade "passes" when `overall_grade >= SCALE_GRADE_PASS_THRESHOLD`.
 * Below ⇒ `scale_grade_below_bar`.
 */
export const MIN_SCALE_PASS_RATE = 0.8;

/**
 * The `overall_grade` floor a SCALE-vocabulary grade must clear to count as
 * a pass. Matches the 30-day Growth-Director-brief rollup's 7/10 "good" band
 * (`src/lib/agents/growth-director.ts` groups grades by kind and reports the
 * per-kind average — the 7-of-10 threshold anchors the pass-rate to that
 * same "sound decision" band the director sees on their brief).
 */
export const SCALE_GRADE_PASS_THRESHOLD = 7;

/**
 * The scaling-judgement vocabulary — the two [[director_activity]] verbs
 * that MOVE budget into or up on a scaler cohort. The gate scores Bianca
 * ONLY on these because that is the judgement it authorises. Blending in
 * `media_buyer_paused_loser` (her ~97%-sound kill skill) would let the
 * strongest skill vouch for the weakest and defeat the supervision.
 */
export const SCALE_ACTION_KINDS = [
  "media_buyer_promoted_winner",
  "media_buyer_replenished_test_cohort",
] as const;
export type ScaleActionKind = (typeof SCALE_ACTION_KINDS)[number];

/** Minimum consecutive `band='green'` sensor-trust snapshots ending at the latest. */
export const MIN_CONSECUTIVE_GREEN_TRUST = 7;

/** Default CAC:LTV target — same 3× floor as the blended composer. Overridable
 *  per-call so a workspace on a shorter payback runway can lower the bar. */
export const DEFAULT_COLD_SCALER_CAC_LTV_TARGET = DEFAULT_BLENDED_CAC_LTV_TARGET;

/** Authorization TTL — one ISO week. The executor treats a row past its
 *  `expires_at` as denied even if `allowed=true`. */
const AUTHORIZATION_TTL_DAYS = 7;

// ── Pure gate ─────────────────────────────────────────────────────────────────

/**
 * The subset of a [[media_buyer_action_grades]] row the pure gate needs.
 * `actionKind` MUST be one of the SCALE-vocabulary kinds — the DB loader is
 * responsible for the vocabulary filter, so the pure gate can assume every
 * row is a scale grade and count it verbatim.
 */
export interface GradedScaleActionInput {
  actionKind: ScaleActionKind;
  overallGrade: number;
  gradedAt: string;
}

export interface TrustSnapshotInput {
  snapshotDate: string;
  band: "green" | "yellow" | "red";
}

/**
 * The CAC:LTV input the pure gate reads. Decoupled from
 * `BlendedCacLtvResult` so the future Phase-8 `media_buyer_cold_scaler_cac_ltv_snapshot`
 * row can feed the same shape without the pure gate importing the sensor
 * spec's types.
 */
export interface CacLtvInput {
  /** cacLtvRatio (LTV/CAC) for the cohort in the window; `null` when
   *  undefined (no CAC / no LTV / no mapping). */
  cacLtvRatio: number | null;
  /** The setpoint the ratio is compared against — DEFAULTs to
   *  `DEFAULT_COLD_SCALER_CAC_LTV_TARGET`. Caller can override. */
  target: number;
  /** Human-readable caveats behind a `null` ratio — surfaced on the
   *  `cac_ltv_unknown` denial detail so the CEO card names WHY (mapping
   *  missing vs. window empty vs. LTV proxy 0). */
  unknownFlags?: string[];
}

export type ColdScalerArmingDenialReason =
  | "insufficient_graded_scale_actions"
  | "scale_grade_below_bar"
  | "trust_no_snapshots"
  | "trust_streak_short"
  | "cac_ltv_below_target"
  | "cac_ltv_unknown";

export interface ColdScalerArmingReason {
  code: ColdScalerArmingDenialReason;
  detail: string;
}

export interface EvaluateColdScalerArmingPureInput {
  gradedScaleActions: GradedScaleActionInput[];
  trustSnapshots: TrustSnapshotInput[];
  cacLtv: CacLtvInput;
}

export interface EvaluateColdScalerArmingPureResult {
  allowed: boolean;
  reasons: ColdScalerArmingReason[];
  metrics: {
    gradedScaleActionCount: number;
    passingScaleActionCount: number;
    scalePassRate: number | null;
    consecutiveGreenCount: number;
    cacLtvRatio: number | null;
    target: number;
  };
}

/**
 * Pure evaluation of the cold-scaler arming gate — no DB, no side effects.
 * Unit tests pin each denial branch by feeding fixtures. The DB-touching
 * runner below composes this with loads + writes.
 */
export function evaluateColdScalerArmingPure(
  input: EvaluateColdScalerArmingPureInput,
): EvaluateColdScalerArmingPureResult {
  const reasons: ColdScalerArmingReason[] = [];

  // ── Precondition 1: SCALE-vocabulary graded pass rate over 14d ─────────
  // The DB loader is responsible for the vocabulary filter (SCALE_ACTION_KINDS);
  // the pure gate defends against a bad caller by re-filtering here so a
  // KILL grade can NEVER lift the verdict — a fixture of all-excellent
  // `media_buyer_paused_loser` grades still lands `insufficient_graded_scale_actions`.
  const scaleGrades = input.gradedScaleActions.filter((g) =>
    (SCALE_ACTION_KINDS as readonly string[]).includes(g.actionKind),
  );
  const gradedScaleActionCount = scaleGrades.length;
  const passingScaleActionCount = scaleGrades.filter(
    (g) => Number.isFinite(g.overallGrade) && g.overallGrade >= SCALE_GRADE_PASS_THRESHOLD,
  ).length;
  const scalePassRate = gradedScaleActionCount > 0 ? passingScaleActionCount / gradedScaleActionCount : null;

  if (gradedScaleActionCount < MIN_GRADED_SCALE_ACTIONS) {
    reasons.push({
      code: "insufficient_graded_scale_actions",
      detail: `only ${gradedScaleActionCount}/${MIN_GRADED_SCALE_ACTIONS} graded scale-actions (${SCALE_ACTION_KINDS.join(" | ")}) in the last ${ARMING_GATE_LOOKBACK_DAYS}d`,
    });
  } else if (scalePassRate !== null && scalePassRate < MIN_SCALE_PASS_RATE) {
    reasons.push({
      code: "scale_grade_below_bar",
      detail: `pass rate ${(scalePassRate * 100).toFixed(1)}% (overall_grade>=${SCALE_GRADE_PASS_THRESHOLD}) below ${(MIN_SCALE_PASS_RATE * 100).toFixed(0)}% floor (${passingScaleActionCount}/${gradedScaleActionCount})`,
    });
  }

  // ── Precondition 2: consecutive green sensor-trust snapshots ────────────
  const consecutiveGreenCount = countConsecutiveGreenSnapshots(input.trustSnapshots);
  if (input.trustSnapshots.length === 0) {
    reasons.push({
      code: "trust_no_snapshots",
      detail: `no media_buyer_sensor_trust snapshots in the last ${ARMING_GATE_LOOKBACK_DAYS}d`,
    });
  } else if (consecutiveGreenCount < MIN_CONSECUTIVE_GREEN_TRUST) {
    reasons.push({
      code: "trust_streak_short",
      detail: `only ${consecutiveGreenCount}/${MIN_CONSECUTIVE_GREEN_TRUST} consecutive green snapshots ending at the latest`,
    });
  }

  // ── Precondition 3: CAC:LTV at/over the target ─────────────────────────
  const target = input.cacLtv.target;
  const cacLtvRatio = input.cacLtv.cacLtvRatio;
  if (cacLtvRatio === null) {
    const flagDetail = (input.cacLtv.unknownFlags || []).join("; ");
    reasons.push({
      code: "cac_ltv_unknown",
      detail: `cold-scaler CAC:LTV undefined (${flagDetail || "no CAC / no LTV / no mapping"})`,
    });
  } else if (cacLtvRatio < target) {
    reasons.push({
      code: "cac_ltv_below_target",
      detail: `cold-scaler CAC:LTV ${cacLtvRatio.toFixed(2)}× below target ${target}×`,
    });
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: {
      gradedScaleActionCount,
      passingScaleActionCount,
      scalePassRate,
      consecutiveGreenCount,
      cacLtvRatio,
      target,
    },
  };
}

/**
 * Count consecutive `band='green'` snapshots ending at the LATEST snapshot
 * date. A yellow / red anywhere breaks the streak — the streak is anchored
 * to today, not the historical maximum.
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
 * ISO 8601 week label for a Date (`YYYY-Www`). The authorization row is
 * keyed by this — the sample window resets weekly.
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

export interface RunColdScalerArmingGateInput {
  workspaceId: string;
  /** null ⇒ workspace-wide row; non-null ⇒ per-account scope. */
  metaAdAccountId?: string | null;
  /** The scaler cohort the gate is authorising — required. */
  coldScalerCohortId: string;
  /** Overrides `DEFAULT_COLD_SCALER_CAC_LTV_TARGET`; surfaced on the pure
   *  gate metrics. */
  targetCacLtv?: number;
  /** Injected clock — tests pin the ISO week + the window bounds. */
  now?: Date;
}

export interface RunColdScalerArmingGateResult {
  status: "allowed" | "denied";
  isoWeek: string;
  authorizationId: string | null;
  reasons: ColdScalerArmingReason[];
  metrics: EvaluateColdScalerArmingPureResult["metrics"];
  /** True when the deny path emitted a new CEO notification (first denial
   *  in this ISO week — subsequent evaluations dedupe via
   *  `escalateDiagnosisToCeo`). */
  ceoEscalationEmitted: boolean;
}

/**
 * The DB-touching entry point. Reads the three preconditions, calls the
 * pure gate, upserts one `media_buyer_cold_scaler_arming_authorization`
 * row, and on deny escalates to the CEO + writes a growth-owned
 * `cold_scaler_arming_denied` audit row.
 */
export async function runColdScalerArmingGate(
  admin: Admin,
  input: RunColdScalerArmingGateInput,
): Promise<RunColdScalerArmingGateResult> {
  const now = input.now ?? new Date();
  const isoWeek = isoWeekLabel(now);
  const windowStartDate = isoDateOffset(now, -ARMING_GATE_LOOKBACK_DAYS);
  const windowEndDate = isoDate(now);
  const target = input.targetCacLtv ?? DEFAULT_COLD_SCALER_CAC_LTV_TARGET;

  const [gradedScaleActions, trustSnapshots, snapshot] = await Promise.all([
    loadColdScalerGradedScaleActions(admin, {
      workspaceId: input.workspaceId,
      metaAdAccountId: input.metaAdAccountId ?? null,
      sinceIso: `${windowStartDate}T00:00:00Z`,
    }),
    loadTrustSnapshots(admin, {
      workspaceId: input.workspaceId,
      metaAdAccountId: input.metaAdAccountId ?? null,
      sinceDate: windowStartDate,
    }),
    // Prefer the campaign-scoped snapshot from the Phase-2
    // [[../../../docs/brain/libraries/media-buyer__cold-scaler-cac-ltv-sensor.md]]
    // sensor (bianca-cold-scaler-campaign-cac-ltv-sensor Phase 2). When a row
    // exists for the cohort, use its cacLtvRatio + flags verbatim — a scaler
    // campaign's own CAC:LTV is what should gate the scaler's arming, not
    // the workspace-blended composite. When absent (sensor hasn't run yet for
    // this cohort) fall through to `computeBlendedCacLtv` for the same 14d
    // window — the pure gate's decoupled `CacLtvInput` shape makes the swap
    // one branch here.
    readLatestColdScalerCacLtvSnapshot(admin, {
      workspaceId: input.workspaceId,
      coldScalerCohortId: input.coldScalerCohortId,
    }),
  ]);

  const cacLtv: CacLtvInput = snapshot
    ? {
        cacLtvRatio: snapshot.cacLtvRatio,
        target,
        unknownFlags: snapshot.flags,
      }
    : await computeBlendedCacLtv({
        workspaceId: input.workspaceId,
        startDate: windowStartDate,
        endDate: windowEndDate,
        targetCacLtv: target,
      }).then((blended) => ({
        cacLtvRatio: blended.cacLtvRatio,
        target,
        unknownFlags: blended.flags,
      }));

  const evaluation = evaluateColdScalerArmingPure({ gradedScaleActions, trustSnapshots, cacLtv });

  const expiresAt = new Date(now.getTime() + AUTHORIZATION_TTL_DAYS * 86_400_000).toISOString();
  const authorizationId = await upsertColdScalerAuthorization(admin, {
    workspaceId: input.workspaceId,
    metaAdAccountId: input.metaAdAccountId ?? null,
    coldScalerCohortId: input.coldScalerCohortId,
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
    coldScalerCohortId: input.coldScalerCohortId,
    isoWeek,
    reasons: evaluation.reasons,
  });
  const dedupeKey = denialDedupeKey({
    workspaceId: input.workspaceId,
    metaAdAccountId: input.metaAdAccountId ?? null,
    coldScalerCohortId: input.coldScalerCohortId,
    isoWeek,
  });

  const ceo = await escalateDiagnosisToCeo(admin, {
    workspaceId: input.workspaceId,
    specSlug: COLD_SCALER_SPEC_SLUG,
    title: `Cold Scaler arming refused (${isoWeek})`,
    diagnosis,
    dedupeKey,
    deepLink: COLD_SCALER_ARMING_GATE_DEEP_LINK,
    escalationKind: "cold_scaler_arming_denied",
    metadata: {
      iso_week: isoWeek,
      meta_ad_account_id: input.metaAdAccountId ?? null,
      cold_scaler_cohort_id: input.coldScalerCohortId,
      reasons: evaluation.reasons,
      metrics: evaluation.metrics,
    },
  });

  await recordDirectorActivity(admin, {
    workspaceId: input.workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "cold_scaler_arming_denied",
    specSlug: COLD_SCALER_SPEC_SLUG,
    reason: diagnosis,
    metadata: {
      iso_week: isoWeek,
      meta_ad_account_id: input.metaAdAccountId ?? null,
      cold_scaler_cohort_id: input.coldScalerCohortId,
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

// ── Read-side guardrail (the graduate-spec chokepoint) ────────────────────────

export interface ReadLatestColdScalerArmingAuthorizationInput {
  workspaceId: string;
  metaAdAccountId?: string | null;
  coldScalerCohortId: string;
}

export interface ColdScalerAuthorizationRow {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  cold_scaler_cohort_id: string;
  iso_week: string;
  allowed: boolean;
  reasons: unknown;
  evaluated_at: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * Returns the newest `media_buyer_cold_scaler_arming_authorization` row for
 * `(workspaceId, metaAdAccountId, coldScalerCohortId)`, or `null` when no
 * row exists. This is the chokepoint the graduate-crowned-winners spec
 * consumes to decide whether the scaler may move budget: a missing row OR
 * `allowed=false` OR a row past its `expires_at` all read as denied — the
 * Bianca M4 north-star's "arming rail must be human-vetoable" encoded at
 * the read site.
 */
export async function readLatestColdScalerArmingAuthorization(
  admin: Admin,
  input: ReadLatestColdScalerArmingAuthorizationInput,
): Promise<ColdScalerAuthorizationRow | null> {
  const base = admin
    .from("media_buyer_cold_scaler_arming_authorization")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("cold_scaler_cohort_id", input.coldScalerCohortId);
  const scoped = input.metaAdAccountId
    ? base.eq("meta_ad_account_id", input.metaAdAccountId)
    : base.is("meta_ad_account_id", null);
  const { data, error } = await scoped
    .order("evaluated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(
      `[cold-scaler-arming-gate] readLatestColdScalerArmingAuthorization failed: ${error.message}`,
    );
    return null;
  }
  return (data as ColdScalerAuthorizationRow | null) ?? null;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Load the last-14-day SCALE-vocabulary grades for one
 * `(workspace, meta_ad_account_id)` cohort from
 * [[../tables/media_buyer_action_grades]]. The grade table has
 * `workspace_id` + `action_kind` directly, but the per-account scope
 * lives on the JOINED `director_activity.metadata.meta_ad_account_id`
 * (same shape as [[./self-correcting]] `loadCohortGrades`) — read with a
 * `!inner` on `director_activity`, then filter in code.
 *
 * The vocabulary filter is applied AT THE DB level via `.in('action_kind',
 * SCALE_ACTION_KINDS)` so a KILL grade cannot reach the pure gate. The
 * pure gate defends against a bad caller by re-filtering, but the loader
 * is the primary chokepoint.
 */
async function loadColdScalerGradedScaleActions(
  admin: Admin,
  opts: { workspaceId: string; metaAdAccountId: string | null; sinceIso: string },
): Promise<GradedScaleActionInput[]> {
  const { data, error } = await admin
    .from("media_buyer_action_grades")
    .select(
      "overall_grade, graded_at, action_kind, director_activity:director_activity!inner(metadata)",
    )
    .eq("workspace_id", opts.workspaceId)
    .in("action_kind", SCALE_ACTION_KINDS as unknown as string[])
    .gte("graded_at", opts.sinceIso);
  if (error) {
    console.warn(
      `[cold-scaler-arming-gate] media_buyer_action_grades read failed: ${error.message}`,
    );
    return [];
  }
  const rows = (data || []) as Array<{
    overall_grade: number | null;
    graded_at: string | null;
    action_kind: string | null;
    director_activity?: { metadata?: Record<string, unknown> | null } | null;
  }>;
  const out: GradedScaleActionInput[] = [];
  for (const r of rows) {
    if (r.graded_at == null) continue;
    if (r.overall_grade == null || !Number.isFinite(r.overall_grade)) continue;
    if (!(SCALE_ACTION_KINDS as readonly string[]).includes(r.action_kind ?? "")) continue;
    const metaAccount = r.director_activity?.metadata?.["meta_ad_account_id"];
    const metaAccountStr = typeof metaAccount === "string" && metaAccount ? metaAccount : null;
    if (opts.metaAdAccountId === null) {
      if (metaAccountStr !== null) continue; // workspace-wide bucket → only rows with NO meta account.
    } else if (metaAccountStr !== opts.metaAdAccountId) {
      continue;
    }
    out.push({
      actionKind: r.action_kind as ScaleActionKind,
      overallGrade: r.overall_grade,
      gradedAt: r.graded_at,
    });
  }
  return out;
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
    console.warn(`[cold-scaler-arming-gate] media_buyer_sensor_trust read failed: ${error.message}`);
    return [];
  }
  const rows = (data || []) as Array<{ snapshot_date: string; band: string }>;
  return rows
    .filter((r): r is { snapshot_date: string; band: "green" | "yellow" | "red" } =>
      r.band === "green" || r.band === "yellow" || r.band === "red",
    )
    .map((r) => ({ snapshotDate: r.snapshot_date, band: r.band }));
}

export async function upsertColdScalerAuthorization(
  admin: Admin,
  args: {
    workspaceId: string;
    metaAdAccountId: string | null;
    coldScalerCohortId: string;
    isoWeek: string;
    allowed: boolean;
    reasons: ColdScalerArmingReason[];
    metrics: EvaluateColdScalerArmingPureResult["metrics"];
    evaluatedAt: string;
    expiresAt: string;
  },
): Promise<string | null> {
  const row = {
    workspace_id: args.workspaceId,
    meta_ad_account_id: args.metaAdAccountId,
    cold_scaler_cohort_id: args.coldScalerCohortId,
    iso_week: args.isoWeek,
    allowed: args.allowed,
    reasons: { reasons: args.reasons, metrics: args.metrics },
    evaluated_at: args.evaluatedAt,
    expires_at: args.expiresAt,
  };

  // The composite unique on (workspace_id, coalesce(meta_ad_account_id::text, ''),
  // cold_scaler_cohort_id, iso_week) is an EXPRESSION index — Postgres can't
  // accept it as an ON CONFLICT column list, and Supabase-js can't pass
  // expressions in `onConflict`. Same select-then-write compare-and-set
  // pattern as the sibling arming-gate's `upsertAuthorization`.
  const selectQ = admin
    .from("media_buyer_cold_scaler_arming_authorization")
    .select("id")
    .eq("workspace_id", args.workspaceId)
    .eq("cold_scaler_cohort_id", args.coldScalerCohortId)
    .eq("iso_week", args.isoWeek);
  const { data: existing } = args.metaAdAccountId
    ? await selectQ.eq("meta_ad_account_id", args.metaAdAccountId).maybeSingle()
    : await selectQ.is("meta_ad_account_id", null).maybeSingle();

  if (existing && (existing as { id: string }).id) {
    const id = (existing as { id: string }).id;
    const { data: updated, error: updErr } = await admin
      .from("media_buyer_cold_scaler_arming_authorization")
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
      console.warn(
        `[cold-scaler-arming-gate] media_buyer_cold_scaler_arming_authorization update failed: ${updErr.message}`,
      );
      return null;
    }
    return Array.isArray(updated) && updated.length === 1 ? id : null;
  }

  const { data: inserted, error: insErr } = await admin
    .from("media_buyer_cold_scaler_arming_authorization")
    .insert(row)
    .select("id");
  if (insErr) {
    console.warn(
      `[cold-scaler-arming-gate] media_buyer_cold_scaler_arming_authorization insert failed: ${insErr.message}`,
    );
    return null;
  }
  const insertedRows = inserted as Array<{ id: string }> | null;
  return Array.isArray(insertedRows) && insertedRows.length === 1 ? insertedRows[0].id : null;
}

// ── Diagnosis + dedupe ────────────────────────────────────────────────────────

function buildDenialDiagnosis(args: {
  workspaceId: string;
  metaAdAccountId: string | null;
  coldScalerCohortId: string;
  isoWeek: string;
  reasons: ColdScalerArmingReason[];
}): string {
  const scope = args.metaAdAccountId ? `account ${args.metaAdAccountId}` : "workspace-wide";
  const bullets = args.reasons.map((r) => `  • ${r.code} — ${r.detail}`).join("\n");
  return (
    `Cold Scaler arming REFUSED for ${scope}, cohort ${args.coldScalerCohortId} (${args.isoWeek}). ` +
    `The scaler stays in shadow — no autonomous budget motion. Reasons:\n${bullets}\n` +
    `Once the failing predicates clear, re-run the gate; the authorization row expires in ${AUTHORIZATION_TTL_DAYS}d.`
  );
}

function denialDedupeKey(args: {
  workspaceId: string;
  metaAdAccountId: string | null;
  coldScalerCohortId: string;
  isoWeek: string;
}): string {
  const accountKey = args.metaAdAccountId ?? "workspace";
  return `cold_scaler_arming_denied:${args.workspaceId}:${accountKey}:${args.coldScalerCohortId}:${args.isoWeek}`;
}

// ── Date utils ────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoDateOffset(d: Date, deltaDays: number): string {
  const t = d.getTime() + deltaDays * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
