/**
 * media-buyer/cold-scaler-arming-gate — Phase 2 of
 * [[../../../docs/brain/specs/bianca-cold-scaler-arming-gate-shadow-to-armed.md]]
 * (Bianca goal M4 "Bounded, supervised cold scaler gated on Dahlia winner
 * supply").
 *
 * The SCALER-rail sibling of [[./arming-gate]]. That gate authorises the TEST
 * cohort's `mode='shadow' → 'armed'` flip; this one authorises the COLD
 * SCALER cohort's flip. Same three preconditions, same denial-branch shape,
 * same weekly ISO-week row-per-authorization pattern — different table
 * ([[media_buyer_cold_scaler_arming_authorization]]), different scope key
 * (`cold_scaler_cohort_id` instead of the account-only pair), different
 * escalation kind (`cold_scaler_arming_denied`).
 *
 * The three preconditions:
 *   1. Shadow-vs-review AGREEMENT — over the last 14d, at least
 *      `MIN_REVIEWED_SHADOW_ACTIONS` shadow actions tagged `metadata.surface='cold_scaler'`
 *      were reviewed AND concur rate ≥ `MIN_AGREEMENT_RATE`. Fewer reviews ⇒
 *      `insufficient_sample`. Concur < floor ⇒ `low_agreement`.
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

/** Minimum reviewed shadow actions before agreement rate is trustworthy. */
export const MIN_REVIEWED_SHADOW_ACTIONS = 20;

/** Minimum concur / reviewed ratio. Below this the gate refuses. */
export const MIN_AGREEMENT_RATE = 0.8;

/** Minimum consecutive `band='green'` sensor-trust snapshots ending at the latest. */
export const MIN_CONSECUTIVE_GREEN_TRUST = 7;

/** Default CAC:LTV target — same 3× floor as the blended composer. Overridable
 *  per-call so a workspace on a shorter payback runway can lower the bar. */
export const DEFAULT_COLD_SCALER_CAC_LTV_TARGET = DEFAULT_BLENDED_CAC_LTV_TARGET;

/** Authorization TTL — one ISO week. The executor treats a row past its
 *  `expires_at` as denied even if `allowed=true`. */
const AUTHORIZATION_TTL_DAYS = 7;

// ── Pure gate ─────────────────────────────────────────────────────────────────

export interface ShadowReviewInput {
  verdict: "concur" | "dissent" | "undecided";
  reviewedAt: string;
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
  | "insufficient_sample"
  | "low_agreement"
  | "trust_no_snapshots"
  | "trust_streak_short"
  | "cac_ltv_below_target"
  | "cac_ltv_unknown";

export interface ColdScalerArmingReason {
  code: ColdScalerArmingDenialReason;
  detail: string;
}

export interface EvaluateColdScalerArmingPureInput {
  shadowReviews: ShadowReviewInput[];
  trustSnapshots: TrustSnapshotInput[];
  cacLtv: CacLtvInput;
}

export interface EvaluateColdScalerArmingPureResult {
  allowed: boolean;
  reasons: ColdScalerArmingReason[];
  metrics: {
    reviewedCount: number;
    concurredCount: number;
    agreementRate: number | null;
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

  // ── Precondition 1: shadow / review agreement over 14d ──────────────────
  const reviewedCount = input.shadowReviews.length;
  const concurredCount = input.shadowReviews.filter((r) => r.verdict === "concur").length;
  const agreementRate = reviewedCount > 0 ? concurredCount / reviewedCount : null;

  if (reviewedCount < MIN_REVIEWED_SHADOW_ACTIONS) {
    reasons.push({
      code: "insufficient_sample",
      detail: `only ${reviewedCount}/${MIN_REVIEWED_SHADOW_ACTIONS} reviewed cold-scaler shadow actions in the last ${ARMING_GATE_LOOKBACK_DAYS}d`,
    });
  } else if (agreementRate !== null && agreementRate < MIN_AGREEMENT_RATE) {
    reasons.push({
      code: "low_agreement",
      detail: `concur rate ${(agreementRate * 100).toFixed(1)}% below ${(MIN_AGREEMENT_RATE * 100).toFixed(0)}% floor (${concurredCount}/${reviewedCount})`,
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
      reviewedCount,
      concurredCount,
      agreementRate,
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

  const [shadowReviews, trustSnapshots, snapshot] = await Promise.all([
    loadColdScalerShadowReviews(admin, {
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

  const evaluation = evaluateColdScalerArmingPure({ shadowReviews, trustSnapshots, cacLtv });

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

// ── Shadow-activity discriminator helper ─────────────────────────────────────

export interface WriteColdScalerShadowActivityInput {
  workspaceId: string;
  /** The kind on the underlying director_activity row (e.g. 'cold_scaler_publish_shadow'). */
  actionKind: string;
  /** Free-text reason surfaced on the activity row. */
  reason: string;
  /** Additional metadata; `mode='shadow'` + `surface='cold_scaler'` are stamped by this
   *  helper so the arming-gate loader can discriminate scaler shadow calls from
   *  test-loop shadow calls. */
  metadata?: Record<string, unknown>;
}

/**
 * Small helper that stamps `metadata.mode='shadow'` + `metadata.surface='cold_scaler'`
 * on a director_activity write so the graduate spec's shadow branch can
 * emit rows that the arming gate can later filter to in its 14d sample.
 * Not the sole write path — callers that already stamp both flags don't
 * need this — but the canonical helper that keeps the discriminator
 * consistent across surfaces.
 */
export async function writeColdScalerShadowActivity(
  admin: Admin,
  input: WriteColdScalerShadowActivityInput,
): Promise<void> {
  await recordDirectorActivity(admin, {
    workspaceId: input.workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: input.actionKind,
    specSlug: COLD_SCALER_SPEC_SLUG,
    reason: input.reason,
    metadata: {
      ...(input.metadata ?? {}),
      mode: "shadow",
      surface: "cold_scaler",
      autonomous: true,
    },
  });
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function loadColdScalerShadowReviews(
  admin: Admin,
  opts: { workspaceId: string; metaAdAccountId: string | null; sinceIso: string },
): Promise<ShadowReviewInput[]> {
  // Scaler shadow reviews are the ones whose parent director_activity row
  // carries `metadata.surface='cold_scaler'` (the discriminator
  // `writeColdScalerShadowActivity` stamps). Join to director_activity via
  // director_activity_id so the loader can filter on that flag AND on the
  // per-account scope. A missing metadata bucket ⇒ excluded — the pure
  // gate then lands `insufficient_sample`, which is the correct dormant
  // behaviour for a workspace that has never emitted a scaler shadow.
  const { data, error } = await admin
    .from("media_buyer_shadow_reviews")
    .select("verdict, reviewed_at, director_activity_id, director_activity:director_activity!inner(metadata)")
    .eq("workspace_id", opts.workspaceId)
    .gte("reviewed_at", opts.sinceIso);
  if (error) {
    console.warn(`[cold-scaler-arming-gate] media_buyer_shadow_reviews read failed: ${error.message}`);
    return [];
  }
  const rows = (data || []) as Array<{
    verdict: string;
    reviewed_at: string;
    director_activity?: { metadata?: Record<string, unknown> | null } | null;
  }>;
  return rows
    .filter((r) => {
      const meta = r.director_activity?.metadata ?? {};
      if (meta["surface"] !== "cold_scaler") return false;
      if (opts.metaAdAccountId === null) return true;
      const metaAccount = meta["meta_ad_account_id"];
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
