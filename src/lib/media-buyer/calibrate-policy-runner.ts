/**
 * media-buyer/calibrate-policy-runner — the DB-touching wrapper around the pure
 * `calibrateMediaBuyerPolicy` from `./policy-calibrator`.
 *
 * Phase 2 of `media-buyer-per-cohort-iteration-policy-calibration` (goal
 * `autonomous-media-buyer-supervision`, M1 "Sensor trust"). The box worker's
 * `calibrate-media-buyer-policy` lane calls this per-workspace + per-account; it:
 *
 *   1. Loads the newest [[../../../docs/brain/tables/media_buyer_sensor_trust]]
 *      snapshot for `(workspaceId, metaAdAccountId)` — refuses with a
 *      `director_activity` `media_buyer_calibration_deferred` row + a `deferred`
 *      result if the band isn't `green` (a `yellow` band is a warning, not a
 *      green light — a calibration proposal on `yellow`/`red` would encode noise
 *      into the pending policy; the north-star principle is "hitting a rail ≡
 *      escalate, not execute").
 *   2. `SELECT roas FROM meta_attribution_daily WHERE workspace_id AND
 *      meta_ad_account_id AND snapshot_date >= today-30d AND roas > 0 AND
 *      variant != '(unresolved)'` — the ROAS distribution.
 *   3. `SELECT spend_cents FROM iteration_scorecards_daily` over the same window
 *      — the spend distribution the pause floor is drawn from.
 *   4. `SELECT sum(spend_cents) FROM daily_meta_ad_spend` over the last 7 days
 *      — the recent-account-spend anchor for the daily-delta ceiling.
 *   5. Calls `calibrateMediaBuyerPolicy` (pure) with the three sample sets.
 *   6. Calls `authorIterationPolicy(admin, { workspaceId, draft, createdBy:'agent',
 *      rationale })` per [[../../../docs/brain/libraries/iteration-policy-authoring.md]]
 *      — writes ONE pending `iteration_policies` row at `version = prior_max+1`.
 *      Activation stays with the owner (that flip is a separate governance
 *      chokepoint — [[iteration-policy-authoring]] `activateIterationPolicy`
 *      routed via the Growth Director's `propose_policy_activation` leash).
 *
 * The runner NEVER activates a policy — that decision belongs to the Growth
 * Director / human. The write path is authored ONLY. The Growth Director's
 * `buildGrowthDirectorBrief` already reads pending versions (per
 * [[../../../docs/brain/libraries/growth-director.md]]) so the new proposal
 * surfaces there for review with zero additional wiring.
 *
 * Sensor-trust gate mirrors the Media Buyer's own dormant-without-clean-probe
 * contract (see [[../../../docs/brain/libraries/media-buyer-agent.md]] § Policy
 * contract). Calibrating a policy on top of a `red`/`yellow`/missing snapshot
 * would author numbers the sensor doesn't justify — same principle that gates
 * the runtime pass.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  calibrateMediaBuyerPolicy,
  EmptyCalibrationSampleError,
  type CalibrateMediaBuyerPolicyResult,
} from "@/lib/media-buyer/policy-calibrator";
import {
  authorIterationPolicy,
  type IterationPolicyDraft,
} from "@/lib/iteration-policy-authoring";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

/** Window the samples are drawn from — matches the spec verification ("last 30d"). */
export const CALIBRATION_ROAS_WINDOW_DAYS = 30;
/** Window the daily-delta ceiling anchor is drawn from — matches the spec
 *  verification ("last 7d account spend"). */
export const CALIBRATION_SPEND_ANCHOR_WINDOW_DAYS = 7;
/** Growth director owns this lane's audit trail. */
const GROWTH_FUNCTION = "growth";
/** The `director_activity.action_kind` we emit on a deferral. */
export const CALIBRATION_DEFERRED_KIND = "media_buyer_calibration_deferred";
/** The `director_activity.action_kind` we emit on a successful proposal (so the
 *  Growth Director's daily recap surfaces the new pending version). */
export const CALIBRATION_PROPOSED_KIND = "media_buyer_calibration_proposed";

export interface RunMediaBuyerPolicyCalibrationInput {
  workspaceId: string;
  /** null ⇒ workspace-wide calibration (matches the workspace-wide sensor-trust
   *  fallback row); non-null ⇒ per-account scope. */
  metaAdAccountId?: string | null;
}

export type RunMediaBuyerPolicyCalibrationResult =
  | {
      status: "proposed";
      policyId: string;
      version: number;
      draft: IterationPolicyDraft;
      rationale: string;
      quantiles: CalibrateMediaBuyerPolicyResult["quantiles"];
      sensorTrust: SensorTrustSummary;
    }
  | {
      status: "deferred";
      reason: DeferralReason;
      reasonDetails: string[];
      sensorTrust: SensorTrustSummary | null;
    };

/** The reasons the runner refuses to author a policy. Each maps to a specific
 *  guard predicate — not a coarse "something went wrong" bucket. */
export type DeferralReason =
  | "sensor_trust_missing"
  | "sensor_trust_not_green"
  | "empty_calibration_sample";

export interface SensorTrustSummary {
  snapshotDate: string | null;
  band: "green" | "yellow" | "red" | null;
  coverageRatio: number | null;
  reasons: string[];
}

/**
 * DB-touching wrapper — the box lane's entry point. Returns a discriminated
 * result: `proposed` on the happy path (one `iteration_policies` row landed
 * `pending`), `deferred` on any refusal (one `director_activity` row landed
 * `media_buyer_calibration_deferred` with structured reasons).
 */
export async function runMediaBuyerPolicyCalibration(
  admin: Admin,
  input: RunMediaBuyerPolicyCalibrationInput,
): Promise<RunMediaBuyerPolicyCalibrationResult> {
  const { workspaceId } = input;
  const metaAdAccountId = input.metaAdAccountId ?? null;

  // ── Guard 1 — the sensor-trust gate ─────────────────────────────────────────
  // Only a fresh `green` snapshot for this exact (workspace, account) scope
  // authorizes a new policy proposal. Missing / yellow / red ⇒ defer + escalate.
  const sensorTrust = await readNewestSensorTrust(admin, workspaceId, metaAdAccountId);
  if (!sensorTrust) {
    const details = [`no media_buyer_sensor_trust row for workspace=${workspaceId} account=${metaAdAccountId ?? "workspace-wide"}`];
    await recordDeferral(admin, {
      workspaceId,
      reason: "sensor_trust_missing",
      reasonDetails: details,
      metaAdAccountId,
      sensorTrust: null,
    });
    return { status: "deferred", reason: "sensor_trust_missing", reasonDetails: details, sensorTrust: null };
  }
  if (sensorTrust.band !== "green") {
    const details = [
      `latest sensor-trust snapshot ${sensorTrust.snapshotDate ?? "?"} banded '${sensorTrust.band ?? "?"}' (only 'green' authorizes calibration)`,
      ...sensorTrust.reasons.map((r) => `probe reason: ${r}`),
    ];
    await recordDeferral(admin, {
      workspaceId,
      reason: "sensor_trust_not_green",
      reasonDetails: details,
      metaAdAccountId,
      sensorTrust,
    });
    return { status: "deferred", reason: "sensor_trust_not_green", reasonDetails: details, sensorTrust };
  }

  // ── Sample loads ────────────────────────────────────────────────────────────
  const today = new Date();
  const roasWindowStart = isoDate(offsetDays(today, -CALIBRATION_ROAS_WINDOW_DAYS));
  const spendAnchorStart = isoDate(offsetDays(today, -CALIBRATION_SPEND_ANCHOR_WINDOW_DAYS));

  const roasSamples = await loadRoasSamples(admin, { workspaceId, metaAdAccountId, sinceDate: roasWindowStart });
  const spendSamplesCents = await loadSpendSamples(admin, { workspaceId, metaAdAccountId, sinceDate: roasWindowStart });
  const recentAccountSpendCents = await loadRecentAccountSpend(admin, {
    workspaceId,
    metaAdAccountId,
    sinceDate: spendAnchorStart,
  });

  const currentPolicy = await loadCurrentPolicy(admin, workspaceId);

  // ── Guard 2 — empty ROAS sample ⇒ category error, not a silent zero-policy ─
  let result: CalibrateMediaBuyerPolicyResult;
  try {
    result = calibrateMediaBuyerPolicy({
      roasSamples,
      spendSamplesCents,
      recentAccountSpendCents,
      currentPolicy,
    });
  } catch (err) {
    if (err instanceof EmptyCalibrationSampleError) {
      const details = [
        `zero non-(unresolved) meta_attribution_daily rows with roas>0 in the last ${CALIBRATION_ROAS_WINDOW_DAYS}d for workspace=${workspaceId} account=${metaAdAccountId ?? "workspace-wide"}`,
      ];
      await recordDeferral(admin, {
        workspaceId,
        reason: "empty_calibration_sample",
        reasonDetails: details,
        metaAdAccountId,
        sensorTrust,
      });
      return { status: "deferred", reason: "empty_calibration_sample", reasonDetails: details, sensorTrust };
    }
    throw err;
  }

  // ── Write ──────────────────────────────────────────────────────────────────
  // authorIterationPolicy lands a pending row at version=max+1. Activation stays
  // with the Growth Director (or a human) via `activateIterationPolicy` — this
  // runner NEVER flips status to active.
  // authorIterationPolicy's API takes 'director' | 'human' and maps 'director' → the
  // DB's constrained 'agent' value on `iteration_policies.created_by` (see
  // [[iteration-policy-authoring]]). Our calibrator is a Growth-Director-supervised
  // autonomous agent, so 'director' is the correct API label; the persisted column
  // reads 'agent' as the spec calls for.
  const authored = await authorIterationPolicy(admin, {
    workspaceId,
    draft: result.draft,
    createdBy: "director",
    rationale: result.rationale,
  });

  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: GROWTH_FUNCTION,
    actionKind: CALIBRATION_PROPOSED_KIND,
    specSlug: "media-buyer-per-cohort-iteration-policy-calibration",
    reason: result.rationale,
    metadata: {
      policy_id: authored.policyId,
      version: authored.version,
      meta_ad_account_id: metaAdAccountId,
      sensor_trust: {
        snapshot_date: sensorTrust.snapshotDate,
        band: sensorTrust.band,
        coverage_ratio: sensorTrust.coverageRatio,
      },
      window_days: CALIBRATION_ROAS_WINDOW_DAYS,
      sample_size: result.quantiles.sampleSize,
      spend_sample_size: result.quantiles.spendSampleSize,
      autonomous: true,
    },
  });

  return {
    status: "proposed",
    policyId: authored.policyId,
    version: authored.version,
    draft: result.draft,
    rationale: result.rationale,
    quantiles: result.quantiles,
    sensorTrust,
  };
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function readNewestSensorTrust(
  admin: Admin,
  workspaceId: string,
  metaAdAccountId: string | null,
): Promise<SensorTrustSummary | null> {
  const scoped = admin
    .from("media_buyer_sensor_trust")
    .select("snapshot_date, band, coverage_ratio, reasons")
    .eq("workspace_id", workspaceId);
  const query = metaAdAccountId === null
    ? scoped.is("meta_ad_account_id", null)
    : scoped.eq("meta_ad_account_id", metaAdAccountId);
  const { data, error } = await query.order("snapshot_date", { ascending: false }).limit(1).maybeSingle();
  if (error) {
    console.warn(`[calibrate-policy-runner] sensor-trust read failed: ${error.message}`);
    return null;
  }
  if (!data) return null;
  const row = data as { snapshot_date: string; band: string; coverage_ratio: number | null; reasons: unknown };
  const band: SensorTrustSummary["band"] =
    row.band === "green" || row.band === "yellow" || row.band === "red" ? row.band : null;
  const reasons = Array.isArray(row.reasons) ? row.reasons.filter((v): v is string => typeof v === "string") : [];
  return {
    snapshotDate: row.snapshot_date,
    band,
    coverageRatio: row.coverage_ratio,
    reasons,
  };
}

async function loadRoasSamples(
  admin: Admin,
  opts: { workspaceId: string; metaAdAccountId: string | null; sinceDate: string },
): Promise<number[]> {
  const scoped = admin
    .from("meta_attribution_daily")
    .select("roas, meta_ad_account_id, variant, snapshot_date")
    .eq("workspace_id", opts.workspaceId)
    .gte("snapshot_date", opts.sinceDate)
    .gt("roas", 0)
    .neq("variant", "(unresolved)");
  const query = opts.metaAdAccountId === null
    ? scoped
    : scoped.eq("meta_ad_account_id", opts.metaAdAccountId);
  const { data, error } = await query;
  if (error) {
    console.warn(`[calibrate-policy-runner] meta_attribution_daily read failed: ${error.message}`);
    return [];
  }
  const rows = (data || []) as Array<{ roas: number | string | null }>;
  return rows
    .map((r) => (typeof r.roas === "string" ? Number(r.roas) : r.roas))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
}

async function loadSpendSamples(
  admin: Admin,
  opts: { workspaceId: string; metaAdAccountId: string | null; sinceDate: string },
): Promise<number[]> {
  const scoped = admin
    .from("iteration_scorecards_daily")
    .select("spend_cents, meta_ad_account_id, snapshot_date")
    .eq("workspace_id", opts.workspaceId)
    .gte("snapshot_date", opts.sinceDate);
  const query = opts.metaAdAccountId === null
    ? scoped
    : scoped.eq("meta_ad_account_id", opts.metaAdAccountId);
  const { data, error } = await query;
  if (error) {
    console.warn(`[calibrate-policy-runner] iteration_scorecards_daily read failed: ${error.message}`);
    return [];
  }
  const rows = (data || []) as Array<{ spend_cents: number | string | null }>;
  return rows
    .map((r) => (typeof r.spend_cents === "string" ? Number(r.spend_cents) : r.spend_cents))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
}

async function loadRecentAccountSpend(
  admin: Admin,
  opts: { workspaceId: string; metaAdAccountId: string | null; sinceDate: string },
): Promise<number> {
  const scoped = admin
    .from("daily_meta_ad_spend")
    .select("spend_cents, meta_ad_account_id, day")
    .eq("workspace_id", opts.workspaceId)
    .gte("day", opts.sinceDate);
  const query = opts.metaAdAccountId === null
    ? scoped
    : scoped.eq("meta_ad_account_id", opts.metaAdAccountId);
  const { data, error } = await query;
  if (error) {
    console.warn(`[calibrate-policy-runner] daily_meta_ad_spend read failed: ${error.message}`);
    return 0;
  }
  const rows = (data || []) as Array<{ spend_cents: number | string | null }>;
  return rows.reduce((sum, r) => {
    const cents = typeof r.spend_cents === "string" ? Number(r.spend_cents) : r.spend_cents;
    return sum + (typeof cents === "number" && Number.isFinite(cents) && cents >= 0 ? cents : 0);
  }, 0);
}

async function loadCurrentPolicy(admin: Admin, workspaceId: string): Promise<Partial<IterationPolicyDraft> | null> {
  const { data, error } = await admin
    .from("iteration_policies")
    .select(
      "roas_floor, scale_up_roas_trigger, scale_up_step_pct, scale_up_cap_pct, scale_down_step_pct, pause_min_spend_cents, pause_window_days, unpause_sales_after_pause, unpause_lookback_days, min_creatives_per_adset, per_object_cooldown_hours, per_account_daily_budget_delta_ceiling_cents, min_budget_floor_cents, never_pause_object_ids, version, status",
    )
    .eq("workspace_id", workspaceId)
    .is("campaign_id", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(`[calibrate-policy-runner] current policy read failed: ${error.message}`);
    return null;
  }
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const num = (k: string): number | null => {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  return {
    roas_floor: num("roas_floor") ?? undefined,
    scale_up_roas_trigger: num("scale_up_roas_trigger") ?? undefined,
    scale_up_step_pct: num("scale_up_step_pct") ?? undefined,
    scale_up_cap_pct: num("scale_up_cap_pct") ?? undefined,
    scale_down_step_pct: num("scale_down_step_pct") ?? undefined,
    pause_min_spend_cents: num("pause_min_spend_cents") ?? undefined,
    pause_window_days: num("pause_window_days") ?? undefined,
    unpause_sales_after_pause: num("unpause_sales_after_pause") ?? undefined,
    unpause_lookback_days: num("unpause_lookback_days") ?? undefined,
    min_creatives_per_adset: num("min_creatives_per_adset") ?? undefined,
    per_object_cooldown_hours: num("per_object_cooldown_hours") ?? undefined,
    per_account_daily_budget_delta_ceiling_cents: num("per_account_daily_budget_delta_ceiling_cents") ?? undefined,
    min_budget_floor_cents: num("min_budget_floor_cents"),
    never_pause_object_ids: Array.isArray(row.never_pause_object_ids)
      ? row.never_pause_object_ids.filter((v): v is string => typeof v === "string")
      : undefined,
  };
}

async function recordDeferral(
  admin: Admin,
  opts: {
    workspaceId: string;
    reason: DeferralReason;
    reasonDetails: string[];
    metaAdAccountId: string | null;
    sensorTrust: SensorTrustSummary | null;
  },
): Promise<void> {
  const reasonText = `Media-buyer policy calibration deferred (${opts.reason}). ${opts.reasonDetails.join("; ")}`;
  await recordDirectorActivity(admin, {
    workspaceId: opts.workspaceId,
    directorFunction: GROWTH_FUNCTION,
    actionKind: CALIBRATION_DEFERRED_KIND,
    specSlug: "media-buyer-per-cohort-iteration-policy-calibration",
    reason: reasonText,
    metadata: {
      reason: opts.reason,
      reason_details: opts.reasonDetails,
      meta_ad_account_id: opts.metaAdAccountId,
      sensor_trust: opts.sensorTrust
        ? {
            snapshot_date: opts.sensorTrust.snapshotDate,
            band: opts.sensorTrust.band,
            coverage_ratio: opts.sensorTrust.coverageRatio,
            reasons: opts.sensorTrust.reasons,
          }
        : null,
      autonomous: true,
    },
  });
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function offsetDays(from: Date, days: number): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
