/**
 * Subscriber lifecycle-experiment harness SDK (spec: subscriber-experiment-harness).
 *
 * The person-level experiment spine the pre-renewal-reminder goal rests on
 * ([[../../docs/brain/goals/pre-renewal-reminder-next-order-journey]] M3 "Self-running 50/50
 * test"). This is the ONE sanctioned chokepoint for the two Phase-1 tables
 * ([[../../docs/brain/tables/customer_lifecycle_experiments]] +
 * [[../../docs/brain/tables/customer_lifecycle_experiment_assignments]]) — CLAUDE.md raw-`.from`
 * STOP rule, enforced by scripts/_check-subscriber-experiments-sdk-compliance.ts.
 *
 * Why a new harness, not storefront_experiments: that framework is visitor/render grain with
 * content-patch variants ([[../../docs/brain/libraries/storefront-experiments]]) — the wrong grain
 * (visitor, not person) and the wrong lever (content, not send/no-send) for a subscriber messaging
 * test. Here assignment is PERSISTED ONCE at the person level and never re-bucketed.
 *
 * Grain is the PERSON, not the account. `assignArm` resolves the customer's full linked-account
 * group ([[../../docs/brain/tables/customer_links]] `group_id`) via `linkedIds()` BEFORE bucketing,
 * so every account of one real person shares ONE arm. The arm is decided by a deterministic sticky
 * hash of `group_id + experiment id` banded into a 50/50 split with a TRUE holdout, then written
 * once under the UNIQUE `(experiment_id, group_id)` constraint — idempotent, sticky, fixed at first
 * eligibility.
 *
 * Supervisable autonomy (north star): the harness is a node under the `retention` function in
 * [[../../docs/brain/libraries/control-tower-node-registry]] with a [[../../docs/brain/tables/kill_switches]]
 * ancestry. `assignArm` honours the switch — a trip stops NEW assignments but never destroys
 * existing ones (an already-assigned group keeps reading its stored arm).
 */
import { createHash } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveEffectiveSwitch } from "@/lib/control-tower/kill-switch-resolver";

type Admin = ReturnType<typeof createAdminClient>;

/** The canonical node id for the harness in the control-tower node registry (owner: retention). */
export const SUBSCRIBER_EXPERIMENT_NODE_ID = "tool:subscriber-experiment-harness";

/**
 * Canonical experiment slug for the pre-renewal reminder test (M2/M3). The daily
 * pre-renewal reminder cron ([[pre-renewal-reminders]]) assigns subscribers to this
 * experiment at first eligibility and only reminds the treatment arm. Dormant until
 * the experiment row is created for the workspace — `assignArm` returns null, so the
 * reminder cron is a no-op until the test is launched.
 */
export const PRE_RENEWAL_EXPERIMENT_SLUG = "pre-renewal-reminder";

/** The two permanent arms. `holdout` gets nothing new; `treatment` gets the reminder. */
export type ExperimentArm = "treatment" | "holdout";

export interface CustomerLifecycleExperimentRow {
  id: string;
  workspace_id: string;
  slug: string;
  status: "draft" | "running" | "stopped" | "complete";
  proxy_metric: string;
  holdout_pct: number;
  target_mde: number | null;
  power: number | null;
  alpha: number | null;
  baseline_cv: number | null;
  required_n_per_arm: number | null;
  stop_rule: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExperimentAssignmentRow {
  id: string;
  workspace_id: string;
  experiment_id: string;
  group_id: string;
  arm: ExperimentArm;
  assigned_at: string;
}

/* ------------------------------------------------------------------------------------------------
 * Linked-account group resolution — grain is the PERSON, not the account.
 * --------------------------------------------------------------------------------------------- */

/**
 * The full set of linked customer ids for `customerId` ([[../../docs/brain/tables/customer_links]]).
 * One real person can hold several linked accounts under one `group_id`; we must resolve that whole
 * group before bucketing so two accounts of the same person never land in opposite arms. Falls back
 * to `[customerId]` when the customer is unlinked (its own singleton group).
 */
export async function linkedIds(admin: Admin, customerId: string): Promise<string[]> {
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: group } = await admin
    .from("customer_links")
    .select("customer_id")
    .eq("group_id", link.group_id);
  const ids = (group || []).map((r) => r.customer_id as string);
  return ids.length > 0 ? ids : [customerId];
}

/**
 * The stable identity GROUP id for `customerId` — the `customer_links.group_id` that all of a
 * person's linked accounts share, or `customerId` itself when the customer is unlinked (its
 * singleton group). THIS is the assignment key, never a bare `customer_id`.
 */
export async function resolveGroupId(admin: Admin, customerId: string): Promise<string> {
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customerId)
    .maybeSingle();
  return link?.group_id ?? customerId;
}

/* ------------------------------------------------------------------------------------------------
 * Sticky deterministic bucketing.
 * --------------------------------------------------------------------------------------------- */

/** Stable hash of a string → a unit float in [0,1). Deterministic across processes (sha256), so
 *  the same `(group_id, experiment id)` always bands to the same arm — the sticky-hash pattern,
 *  keyed on the person GROUP rather than a visitor id. */
export function hashToUnit(key: string): number {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return parseInt(hex, 16) / 0x100000000;
}

/**
 * Band a group's unit hash into an arm for an experiment.
 *   • holdout band  [0, holdout_pct/100)   → holdout (TRUE holdout — never reallocated)
 *   • remainder                             → treatment
 * A 50/50 test with a real holdout is `holdout_pct = 50`.
 */
export function bucketArm(experimentId: string, groupId: string, holdoutPct: number): ExperimentArm {
  const u = hashToUnit(`${groupId}:${experimentId}`);
  return u < holdoutPct / 100 ? "holdout" : "treatment";
}

/* ------------------------------------------------------------------------------------------------
 * Pre-registered power calculation + stop rule.
 * --------------------------------------------------------------------------------------------- */

export interface PowerCalcInput {
  /** target minimum detectable effect — relative lift on the proxy metric (e.g. 0.05 = 5%). */
  mde: number;
  /** statistical power 1 - beta (e.g. 0.8). */
  power: number;
  /** significance level alpha (e.g. 0.05). */
  alpha: number;
  /** assumed baseline coefficient of variation of the (continuous) proxy metric. */
  baselineCv: number;
}

/** Inverse standard-normal CDF (Acklam's rational approximation) — z for a cumulative probability
 *  p, used to turn alpha/power into critical z-values without a stats dependency. */
function invNorm(p: number): number {
  // coefficients
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * Required sample size PER ARM for a two-sided two-sample test on a continuous proxy metric.
 * Standard n = 2 (z_{1-α/2} + z_{1-β})² · CV² / MDE². Pre-registered BEFORE launch so the verdict
 * reads a fixed N rather than deciding N after seeing data. Returns an integer (rounded up).
 */
export function powerCalcRequiredN(input: PowerCalcInput): number {
  const { mde, power, alpha, baselineCv } = input;
  if (!(mde > 0) || !(baselineCv > 0)) {
    throw new Error("powerCalcRequiredN: mde and baselineCv must be positive");
  }
  const zAlpha = invNorm(1 - alpha / 2);
  const zBeta = invNorm(power);
  const n = (2 * Math.pow(zAlpha + zBeta, 2) * Math.pow(baselineCv, 2)) / Math.pow(mde, 2);
  return Math.ceil(n);
}

export interface CreateExperimentInput {
  slug: string;
  proxyMetric?: string;
  /** holdout share 0..100 — a 50/50 test with a true holdout is 50. */
  holdoutPct?: number;
  powerCalc: PowerCalcInput;
  /** the pre-registered stop rule describing when the test ends. */
  stopRule: string;
  status?: "draft" | "running";
}

/**
 * Create (or idempotently fetch) the experiment row, stamping its PRE-REGISTERED sample size (from
 * the power calc) and stop rule at creation time — nothing downstream can launch the test without
 * these fields populated. Idempotent on `(workspace_id, slug)`.
 */
export async function createExperiment(
  workspaceId: string,
  input: CreateExperimentInput,
  admin: Admin = createAdminClient(),
): Promise<CustomerLifecycleExperimentRow> {
  const existing = await getExperiment(workspaceId, input.slug, admin);
  if (existing) return existing;

  const requiredNPerArm = powerCalcRequiredN(input.powerCalc);
  const { data, error } = await admin
    .from("customer_lifecycle_experiments")
    .insert({
      workspace_id: workspaceId,
      slug: input.slug,
      status: input.status ?? "draft",
      proxy_metric: input.proxyMetric ?? "90d_net_revenue_per_customer",
      holdout_pct: input.holdoutPct ?? 50,
      target_mde: input.powerCalc.mde,
      power: input.powerCalc.power,
      alpha: input.powerCalc.alpha,
      baseline_cv: input.powerCalc.baselineCv,
      required_n_per_arm: requiredNPerArm,
      stop_rule: input.stopRule,
    })
    .select("*")
    .single();
  if (error) {
    // A concurrent create may have won the (workspace_id, slug) unique race — re-read.
    const raced = await getExperiment(workspaceId, input.slug, admin);
    if (raced) return raced;
    throw new Error(`createExperiment(${input.slug}): ${error.message}`);
  }
  return data as CustomerLifecycleExperimentRow;
}

export async function getExperiment(
  workspaceId: string,
  slug: string,
  admin: Admin = createAdminClient(),
): Promise<CustomerLifecycleExperimentRow | null> {
  const { data } = await admin
    .from("customer_lifecycle_experiments")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  return (data as CustomerLifecycleExperimentRow | null) ?? null;
}

/* ------------------------------------------------------------------------------------------------
 * Assignment — sticky per-customer 50/50 + true holdout.
 * --------------------------------------------------------------------------------------------- */

/**
 * Read a customer's STORED arm without ever creating a new assignment. Resolves the linked-account
 * group first so any account of the person reads the same arm. Returns null if the group has never
 * been assigned (or the experiment doesn't exist) — callers that must not mint a new arm use this.
 */
export async function getArm(
  workspaceId: string,
  experimentSlug: string,
  customerId: string,
  admin: Admin = createAdminClient(),
): Promise<ExperimentArm | null> {
  const experiment = await getExperiment(workspaceId, experimentSlug, admin);
  if (!experiment) return null;
  const groupId = await resolveGroupId(admin, customerId);
  const { data } = await admin
    .from("customer_lifecycle_experiment_assignments")
    .select("arm")
    .eq("experiment_id", experiment.id)
    .eq("group_id", groupId)
    .maybeSingle();
  return (data?.arm as ExperimentArm | undefined) ?? null;
}

/**
 * List EVERY sticky assignment for an experiment — the read surface the measurement engines
 * ([[subscriber-experiment-metrics]]) bucket by. Reads the assignments table through the SDK so
 * no downstream consumer hand-rolls a raw `.from('customer_lifecycle_experiment_assignments')`
 * (CLAUDE.md raw-`.from` STOP rule; this is the sanctioned read chokepoint). Returns [] when the
 * experiment doesn't exist for the workspace. Each row carries the person `group_id`, its permanent
 * `arm`, and `assigned_at` (the anchor for a per-person measurement window).
 */
export async function listAssignments(
  workspaceId: string,
  experimentSlug: string,
  admin: Admin = createAdminClient(),
): Promise<ExperimentAssignmentRow[]> {
  const experiment = await getExperiment(workspaceId, experimentSlug, admin);
  if (!experiment) return [];
  const { data, error } = await admin
    .from("customer_lifecycle_experiment_assignments")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("experiment_id", experiment.id);
  if (error) throw new Error(`listAssignments(${experimentSlug}): ${error.message}`);
  return (data as ExperimentAssignmentRow[] | null) ?? [];
}

/**
 * Assign (or read) a customer's permanent arm for an experiment — the harness's core call.
 *
 *   1. Resolve the customer's full linked-account GROUP (`resolveGroupId`) so all of a person's
 *      accounts share one arm — grain is the person, not the account.
 *   2. If an assignment already exists for the group, return the STORED arm (sticky — fixed at
 *      first eligibility, never re-bucketed).
 *   3. Otherwise honour the kill switch: if the harness node is OFF, DO NOT mint a new assignment
 *      (returns null) — a trip stops new assignments without destroying existing ones.
 *   4. Band the group's sticky hash into treatment/holdout at the configured split and persist it
 *      once under the UNIQUE (experiment_id, group_id) constraint. A concurrent first-touch race
 *      converges on the single winning insert.
 */
export async function assignArm(
  workspaceId: string,
  experimentSlug: string,
  customerId: string,
  admin: Admin = createAdminClient(),
): Promise<ExperimentArm | null> {
  const experiment = await getExperiment(workspaceId, experimentSlug, admin);
  if (!experiment) return null;

  const groupId = await resolveGroupId(admin, customerId);

  // Already assigned? Return the stored arm — sticky + idempotent.
  const existing = await admin
    .from("customer_lifecycle_experiment_assignments")
    .select("arm")
    .eq("experiment_id", experiment.id)
    .eq("group_id", groupId)
    .maybeSingle();
  if (existing.data?.arm) return existing.data.arm as ExperimentArm;

  // No assignment yet — honour the kill switch before minting a new one. A trip halts NEW
  // assignments but leaves every existing arm intact (we already returned those above).
  const sw = await resolveEffectiveSwitch(SUBSCRIBER_EXPERIMENT_NODE_ID);
  if (sw.off) return null;

  const arm = bucketArm(experiment.id, groupId, experiment.holdout_pct);
  const { data, error } = await admin
    .from("customer_lifecycle_experiment_assignments")
    .insert({
      workspace_id: workspaceId,
      experiment_id: experiment.id,
      group_id: groupId,
      arm,
    })
    .select("arm")
    .single();
  if (error) {
    // Lost the (experiment_id, group_id) unique race to a concurrent first-touch — read the winner.
    const raced = await admin
      .from("customer_lifecycle_experiment_assignments")
      .select("arm")
      .eq("experiment_id", experiment.id)
      .eq("group_id", groupId)
      .maybeSingle();
    if (raced.data?.arm) return raced.data.arm as ExperimentArm;
    throw new Error(`assignArm(${experimentSlug}, ${customerId}): ${error.message}`);
  }
  return data.arm as ExperimentArm;
}
