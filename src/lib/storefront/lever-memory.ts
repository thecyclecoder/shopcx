/**
 * Storefront lever-importance memory — the persistent BRAIN of the
 * storefront-optimizer agent (docs/brain/specs/storefront-lever-importance-memory.md,
 * M2). Turns one-off M1 experiments into a compounding, hierarchical, LEARNED
 * lever-importance map: a two-level bandit (which lever to test × which variant wins).
 *
 *   updatePosterior(experiment) — consume a completed M1 experiment
 *     ([[storefront-experiment-bandit-framework]] outcome + the M3 predicted-LTV-proxy
 *     delta as the reward) and Bayesian-update the tested lever's importance for that
 *     (product × lander_type × audience). A meaningful proxy lift raises it; a ~0 delta
 *     demotes it. APPEND-EVIDENCE + recompute-from-prior → idempotent per experiment.
 *   decayLeverImportance(...) — drift every posterior toward its prior with age, so a
 *     written-off lever resurrects and can be re-probed (explore stays alive).
 *   nextLeverToTest(cohort) — the which-lever half of the two-level bandit: a UCB
 *     explore/exploit selector that returns the highest-value lever to test next
 *     (high posterior = exploit; decayed / never-tested = explore), seeded from
 *     `general` learnings on a brand-new cohort (cross-product transfer).
 *   applyReconcilerSignals(...) — intake the M3 reconciler's recalibration signal
 *     ([[storefront-ltv-proxy-reconciler]] Phase 3) when present; soft dependency.
 *
 * North star: the map is a TOOL, not the objective — it directs scarce test budget;
 * the Growth director + the M3 reconciler supervise it. Every update is reasoned +
 * surfaced (the evidence log), never a silent proxy-optimizer.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { LanderType } from "@/lib/storefront/experiments";

type Admin = ReturnType<typeof createAdminClient>;

// ── Tunables ────────────────────────────────────────────────────────────────

/** Pseudo-observation weight of the prior in the posterior average. The prior counts
 *  as roughly one observation, so the first real experiment moves importance decisively
 *  but never instantly overwrites the prior. */
export const PRIOR_WEIGHT = 1.0;

/** A proxy lift of this fraction over control = full "this lever matters" signal (1.0).
 *  A 50% LTV-proxy-per-session lift is a strong lever effect. */
export const SIGNAL_SCALE = 0.5;

/** Floor on control LTV-per-session (cents) when normalizing the proxy delta, so a
 *  near-zero control denominator doesn't explode the signal. */
export const MIN_LTV_DENOM_CENTS = 100;

/** Sessions at which an experiment's evidence carries full weight; below this it's
 *  down-weighted (don't let a thin test swing the posterior as hard as a deep one). */
export const FULL_CONFIDENCE_SESSIONS = 500;
/** A committed experiment never counts for less than this (a real outcome is real). */
export const MIN_EVIDENCE_WEIGHT = 0.5;

/** Importance decays toward prior with a 30-day half-life. After ~1 half-life a
 *  written-off lever has drifted halfway back to its prior — enough to be re-probed. */
export const DECAY_HALF_LIFE_DAYS = 30;

/** UCB exploration coefficient for nextLeverToTest — higher = more exploration. */
export const EXPLORE_C = 0.4;
/** Days after which a tested lever is "stale" and earns a re-probe explore bonus. */
export const STALE_AFTER_DAYS = 45;

const DAY_MS = 24 * 60 * 60 * 1000;
const ALL_LANDER_TYPES: LanderType[] = ["pdp", "listicle", "beforeafter", "advertorial"];

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface LeverRow {
  id: string;
  parent_lever_id: string | null;
  lever_key: string;
  chapter: string;
  level: "chapter" | "component";
  label: string;
  prior: number;
  lander_types: string[];
  default_scope: "product_specific" | "general";
}

export interface EvidenceEntry {
  experiment_id: string;
  /** Normalized proxy delta vs control (best arm). Positive = lift. */
  proxy_delta: number;
  /** Magnitude signal ∈ [0,1] — how much this lever moved the proxy (either direction). */
  signal: number;
  /** Confidence weight of this observation (sessions-based). */
  weight: number;
  action: string;
  at: string;
  source?: string;
}

export interface LeverImportanceRow {
  id: string;
  workspace_id: string;
  lever_id: string;
  product_id: string;
  lander_type: string;
  audience: string;
  importance: number;
  prior: number;
  n_tests: number;
  last_tested_at: string | null;
  evidence: EvidenceEntry[];
  scope: "product_specific" | "general";
}

export interface Cohort {
  workspaceId: string;
  productId: string;
  landerType: LanderType;
  audience?: string;
}

// ── Lever taxonomy resolution ────────────────────────────────────────────────

/** Resolve an M1 experiment's free-text `lever` to a canonical storefront_levers row.
 *  Tries exact lever_key, then a normalized (snake_case) match against key/chapter/label. */
export async function resolveLever(admin: Admin, leverText: string): Promise<LeverRow | null> {
  const raw = (leverText || "").trim();
  if (!raw) return null;
  const norm = raw.toLowerCase().replace(/[\s-]+/g, "_");

  const { data: exact } = await admin
    .from("storefront_levers")
    .select("id, parent_lever_id, lever_key, chapter, level, label, prior, lander_types, default_scope")
    .eq("lever_key", norm)
    .maybeSingle();
  if (exact) return exact as LeverRow;

  // Fallback: scan + fuzzy-match (small canonical table).
  const { data: all } = await admin
    .from("storefront_levers")
    .select("id, parent_lever_id, lever_key, chapter, level, label, prior, lander_types, default_scope");
  const rows = (all as LeverRow[]) || [];
  const normLabel = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "_");
  return (
    rows.find((r) => normLabel(r.lever_key) === norm) ||
    rows.find((r) => normLabel(r.label) === norm) ||
    rows.find((r) => normLabel(r.chapter) === norm) ||
    null
  );
}

// ── Posterior math (pure) ─────────────────────────────────────────────────────

/** Recompute the posterior importance from the prior + the full evidence log. Pure:
 *  importance = weighted average of (prior @ PRIOR_WEIGHT) and each evidence signal @
 *  its confidence weight. Deterministic → recomputing on every update is idempotent. */
export function posteriorFromEvidence(prior: number, evidence: EvidenceEntry[]): number {
  let num = prior * PRIOR_WEIGHT;
  let den = PRIOR_WEIGHT;
  for (const e of evidence) {
    const w = Math.max(MIN_EVIDENCE_WEIGHT, e.weight ?? MIN_EVIDENCE_WEIGHT);
    num += clamp01(e.signal) * w;
    den += w;
  }
  return clamp01(den > 0 ? num / den : prior);
}

/** The age-decayed importance of a posterior toward its prior (read-side/decay-pass). */
export function decayedImportance(row: { importance: number; prior: number; last_tested_at: string | null }, now: Date): number {
  if (!row.last_tested_at) return clamp01(row.importance);
  const ageDays = Math.max(0, (now.getTime() - new Date(row.last_tested_at).getTime()) / DAY_MS);
  const factor = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
  return clamp01(row.prior + (row.importance - row.prior) * factor);
}

interface ArmRollupLite {
  is_control: boolean;
  sessions: number;
  ltv_proxy_cents: number;
}

/** Reward = the best non-control arm's predicted-LTV-proxy delta per session vs
 *  control, normalized. signal = how much the lever MOVED the proxy (|delta|) — a big
 *  win and a big loss both prove the lever is high-leverage; a ~0 delta proves it isn't. */
export function rewardFromRollups(rollups: ArmRollupLite[]): { proxyDelta: number; signal: number; sessions: number } {
  const control = rollups.find((r) => r.is_control);
  const arms = rollups.filter((r) => !r.is_control);
  const perSession = (r: ArmRollupLite) => (r.sessions > 0 ? r.ltv_proxy_cents / r.sessions : 0);
  if (!control || arms.length === 0) return { proxyDelta: 0, signal: 0, sessions: 0 };
  const controlLtv = perSession(control);
  // Best arm by absolute distance from control (largest proven effect).
  const best = arms.slice().sort((a, b) => Math.abs(perSession(b) - controlLtv) - Math.abs(perSession(a) - controlLtv))[0];
  const denom = Math.max(controlLtv, MIN_LTV_DENOM_CENTS);
  const proxyDelta = (perSession(best) - controlLtv) / denom;
  const signal = clamp01(Math.abs(proxyDelta) / SIGNAL_SCALE);
  const sessions = control.sessions + arms.reduce((s, a) => s + a.sessions, 0);
  return { proxyDelta, signal, sessions };
}

function evidenceWeight(sessions: number): number {
  return Math.max(MIN_EVIDENCE_WEIGHT, clamp01(sessions / FULL_CONFIDENCE_SESSIONS));
}

// ── Cross-product transfer seed ───────────────────────────────────────────────

/** The seed importance + scope for a brand-new (lever × product × lander × audience)
 *  cohort: if `general` learnings exist for this lever+lander+audience on OTHER products,
 *  transfer their average (cross-product transfer); else the cold lever prior. */
export async function seedFor(
  admin: Admin,
  lever: LeverRow,
  cohort: Required<Cohort>,
): Promise<{ prior: number; scope: "product_specific" | "general"; source: "general_transfer" | "cold_prior" }> {
  const { data } = await admin
    .from("storefront_lever_importance")
    .select("importance, product_id")
    .eq("lever_id", lever.id)
    .eq("lander_type", cohort.landerType)
    .eq("audience", cohort.audience)
    .eq("scope", "general")
    .neq("product_id", cohort.productId);
  const generals = (data as { importance: number }[]) || [];
  if (generals.length > 0) {
    const avg = generals.reduce((s, r) => s + r.importance, 0) / generals.length;
    return { prior: clamp01(avg), scope: "general", source: "general_transfer" };
  }
  return { prior: clamp01(lever.prior), scope: lever.default_scope, source: "cold_prior" };
}

function rowToImportance(r: Record<string, unknown>): LeverImportanceRow {
  return {
    id: r.id as string,
    workspace_id: r.workspace_id as string,
    lever_id: r.lever_id as string,
    product_id: r.product_id as string,
    lander_type: r.lander_type as string,
    audience: r.audience as string,
    importance: r.importance as number,
    prior: r.prior as number,
    n_tests: r.n_tests as number,
    last_tested_at: (r.last_tested_at as string | null) ?? null,
    evidence: Array.isArray(r.evidence) ? (r.evidence as EvidenceEntry[]) : [],
    scope: (r.scope as "product_specific" | "general") ?? "product_specific",
  };
}

/** Fetch the posterior row for a cohort+lever, creating it from the transfer/cold seed
 *  if absent. */
async function getOrCreateImportance(
  admin: Admin,
  lever: LeverRow,
  cohort: Required<Cohort>,
  now: Date,
): Promise<LeverImportanceRow> {
  const { data: existing } = await admin
    .from("storefront_lever_importance")
    .select("*")
    .eq("lever_id", lever.id)
    .eq("product_id", cohort.productId)
    .eq("lander_type", cohort.landerType)
    .eq("audience", cohort.audience)
    .maybeSingle();
  if (existing) return rowToImportance(existing as Record<string, unknown>);

  const seed = await seedFor(admin, lever, cohort);
  const stamp = now.toISOString();
  const { data: inserted } = await admin
    .from("storefront_lever_importance")
    .insert({
      workspace_id: cohort.workspaceId,
      lever_id: lever.id,
      product_id: cohort.productId,
      lander_type: cohort.landerType,
      audience: cohort.audience,
      importance: seed.prior,
      prior: seed.prior,
      n_tests: 0,
      evidence: [],
      scope: seed.scope,
      created_at: stamp,
      updated_at: stamp,
    })
    .select("*")
    .single();
  return rowToImportance(inserted as Record<string, unknown>);
}

// ── updatePosterior — commit one M1 experiment outcome ─────────────────────────

export interface UpdatePosteriorResult {
  status: "updated" | "skipped_idempotent" | "skipped_no_lever" | "skipped_not_complete" | "skipped_no_data";
  lever_key?: string;
  importance?: number;
  prior?: number;
  n_tests?: number;
  proxy_delta?: number;
}

/**
 * Consume ONE completed M1 experiment and Bayesian-update the tested lever's importance
 * for its (product × lander_type × audience). Idempotent: the experiment is appended to
 * the posterior's evidence exactly once (keyed by experiment id), then importance is
 * recomputed from prior + evidence. A loss is recorded as much as a win (commit the
 * learning, win or loss) — never silently dropped.
 */
export async function updatePosterior(opts: {
  experimentId: string;
  admin?: Admin;
  now?: Date;
  /** Optional rollups override (testing / pre-loaded); else read from variants. */
  rollups?: ArmRollupLite[];
}): Promise<UpdatePosteriorResult> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();

  const { data: exp } = await admin
    .from("storefront_experiments")
    .select("id, workspace_id, product_id, lander_type, audience, lever, status, last_decision")
    .eq("id", opts.experimentId)
    .maybeSingle();
  if (!exp) return { status: "skipped_no_data" };

  // A "completed" experiment = it reached a terminal bandit outcome.
  const action =
    exp.status === "promoted" ? "promote" : exp.status === "killed" ? "kill" : exp.status === "rolled_back" ? "rolled_back" : null;
  if (!action) return { status: "skipped_not_complete" };

  const lever = await resolveLever(admin, exp.lever as string);
  if (!lever) {
    console.warn(`[lever-memory] no canonical lever for experiment=${exp.id} lever="${exp.lever}" — learning not committed`);
    return { status: "skipped_no_lever" };
  }

  // Reward from the variant rollups (predicted-LTV-proxy delta vs control).
  let rollups = opts.rollups;
  if (!rollups) {
    const { data: vs } = await admin
      .from("storefront_experiment_variants")
      .select("is_control, sessions, ltv_proxy_cents")
      .eq("experiment_id", exp.id);
    rollups = ((vs as ArmRollupLite[]) || []).map((v) => ({
      is_control: v.is_control,
      sessions: v.sessions ?? 0,
      ltv_proxy_cents: v.ltv_proxy_cents ?? 0,
    }));
  }
  const { proxyDelta, signal, sessions } = rewardFromRollups(rollups);

  const cohort: Required<Cohort> = {
    workspaceId: exp.workspace_id as string,
    productId: exp.product_id as string,
    landerType: exp.lander_type as LanderType,
    audience: (exp.audience as string) || "all",
  };
  const row = await getOrCreateImportance(admin, lever, cohort, now);

  // Idempotent: if this experiment already contributed, do nothing.
  if (row.evidence.some((e) => e.experiment_id === exp.id)) {
    return { status: "skipped_idempotent", lever_key: lever.lever_key, importance: row.importance, prior: row.prior, n_tests: row.n_tests };
  }

  const entry: EvidenceEntry = {
    experiment_id: exp.id as string,
    proxy_delta: Math.round(proxyDelta * 1000) / 1000,
    signal: Math.round(signal * 1000) / 1000,
    weight: Math.round(evidenceWeight(sessions) * 1000) / 1000,
    action,
    at: now.toISOString(),
  };
  const evidence = [...row.evidence, entry];
  const importance = posteriorFromEvidence(row.prior, evidence);

  await admin
    .from("storefront_lever_importance")
    .update({
      importance,
      n_tests: evidence.length,
      last_tested_at: now.toISOString(),
      evidence,
      updated_at: now.toISOString(),
    })
    .eq("id", row.id);

  // Surface, don't bury — a posterior swing is reasoned + logged (north star).
  console.log(
    `[lever-memory] committed experiment=${exp.id} lever=${lever.lever_key} product=${cohort.productId} ` +
      `${cohort.landerType}/${cohort.audience} delta=${entry.proxy_delta} signal=${entry.signal} ` +
      `importance ${row.prior.toFixed(3)}→${importance.toFixed(3)} n_tests=${evidence.length}`,
  );

  return { status: "updated", lever_key: lever.lever_key, importance, prior: row.prior, n_tests: evidence.length, proxy_delta: entry.proxy_delta };
}

// ── decay pass ────────────────────────────────────────────────────────────────

export interface DecayResult {
  scanned: number;
  drifted: number;
}

/** Drift every posterior in a workspace toward its prior by age (persisted). Keeps
 *  exploration alive: a written-off lever's posterior rises back toward prior so it gets
 *  re-probed. Does NOT touch evidence or last_tested_at — a fresh experiment recomputes
 *  importance from evidence at full strength and resets the clock. */
export async function decayLeverImportance(opts: { workspaceId: string; admin?: Admin; now?: Date }): Promise<DecayResult> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  const { data } = await admin
    .from("storefront_lever_importance")
    .select("id, importance, prior, last_tested_at")
    .eq("workspace_id", opts.workspaceId);
  const rows = (data as { id: string; importance: number; prior: number; last_tested_at: string | null }[]) || [];
  let drifted = 0;
  for (const r of rows) {
    const next = decayedImportance(r, now);
    if (Math.abs(next - r.importance) < 1e-4) continue;
    await admin
      .from("storefront_lever_importance")
      .update({ importance: next, updated_at: now.toISOString() })
      .eq("id", r.id);
    drifted++;
  }
  return { scanned: rows.length, drifted };
}

// ── nextLeverToTest — the which-lever bandit ──────────────────────────────────

export interface LeverCandidate {
  lever_id: string;
  lever_key: string;
  chapter: string;
  level: "chapter" | "component";
  label: string;
  importance: number;
  prior: number;
  n_tests: number;
  last_tested_at: string | null;
  scope: "product_specific" | "general";
  /** UCB selection score = exploit (decayed importance) + explore bonus. */
  score: number;
  mode: "exploit" | "explore";
  reason: string;
}

export interface NextLeverResult {
  pick: LeverCandidate | null;
  candidates: LeverCandidate[];
}

/**
 * The which-lever half of the two-level bandit: rank the applicable levers for a cohort
 * by a UCB explore/exploit score and return the highest-value one to test next.
 *   • exploit — high decayed posterior importance.
 *   • explore — never-tested (no posterior; seeded from `general` learnings if any, else
 *     cold prior) or stale/decayed (drifted back toward prior) → earns a re-probe bonus.
 */
export async function nextLeverToTest(cohort: Cohort & { admin?: Admin; now?: Date }): Promise<NextLeverResult> {
  const admin = cohort.admin ?? createAdminClient();
  const now = cohort.now ?? new Date();
  const audience = cohort.audience || "all";
  const landerType = cohort.landerType;

  // Applicable levers for this lander type.
  const { data: leversData } = await admin
    .from("storefront_levers")
    .select("id, parent_lever_id, lever_key, chapter, level, label, prior, lander_types, default_scope");
  const levers = ((leversData as LeverRow[]) || []).filter(
    (l) => !l.lander_types || l.lander_types.length === 0 || l.lander_types.includes(landerType),
  );
  if (levers.length === 0) return { pick: null, candidates: [] };

  // Existing posteriors for this cohort.
  const { data: impData } = await admin
    .from("storefront_lever_importance")
    .select("*")
    .eq("product_id", cohort.productId)
    .eq("lander_type", landerType)
    .eq("audience", audience);
  const impByLever = new Map<string, LeverImportanceRow>();
  for (const r of (impData as Record<string, unknown>[]) || []) {
    const row = rowToImportance(r);
    impByLever.set(row.lever_id, row);
  }

  const totalTests = [...impByLever.values()].reduce((s, r) => s + r.n_tests, 0);
  const lnT = Math.log(totalTests + 1);

  const candidates: LeverCandidate[] = [];
  for (const lever of levers) {
    const existing = impByLever.get(lever.id);
    let importance: number;
    let prior: number;
    let nTests: number;
    let lastTested: string | null;
    let scope: "product_specific" | "general";
    let reason: string;

    if (existing) {
      importance = decayedImportance(existing, now);
      prior = existing.prior;
      nTests = existing.n_tests;
      lastTested = existing.last_tested_at;
      scope = existing.scope;
      const ageDays = lastTested ? (now.getTime() - new Date(lastTested).getTime()) / DAY_MS : Infinity;
      reason = ageDays > STALE_AFTER_DAYS ? "stale_decayed_reprobe" : "tested";
    } else {
      // Never tested for this cohort → seed (cross-product transfer or cold prior).
      const seed = await seedFor(admin, lever, { workspaceId: cohort.workspaceId, productId: cohort.productId, landerType, audience });
      importance = seed.prior;
      prior = seed.prior;
      nTests = 0;
      lastTested = null;
      scope = seed.scope;
      reason = seed.source === "general_transfer" ? "untested_general_transfer" : "untested_cold_prior";
    }

    // UCB: exploit term (decayed importance) + explore bonus (unexplored / stale).
    const explore = EXPLORE_C * Math.sqrt(lnT / (nTests + 1));
    const score = clamp01(importance) + explore;
    const mode: "exploit" | "explore" = nTests === 0 || explore >= importance ? "explore" : "exploit";
    candidates.push({
      lever_id: lever.id,
      lever_key: lever.lever_key,
      chapter: lever.chapter,
      level: lever.level,
      label: lever.label,
      importance: Math.round(importance * 1000) / 1000,
      prior: Math.round(prior * 1000) / 1000,
      n_tests: nTests,
      last_tested_at: lastTested,
      scope,
      score: Math.round(score * 1000) / 1000,
      mode,
      reason,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return { pick: candidates[0] ?? null, candidates };
}

// ── M3 reconciler recalibration intake (soft dependency) ──────────────────────

export interface ReconcilerSignal {
  lever_key?: string;
  chapter?: string;
  product_id?: string | null;
  lander_type?: string | null;
  audience?: string | null;
  /** Multiplicative adjustment to importance (e.g. 0.8 = the proxy over-predicted LTV,
   *  discount-heavy offers churn → demote this lever class). */
  adjust_factor: number;
  reason?: string;
}

export interface ReconcilerResult {
  signals: number;
  adjusted: number;
}

/**
 * Intake the M3 reconciler's recalibration signal: when the ~4-month slow loop finds a
 * lever class systematically over/under-predicted, scale the matching posteriors.
 * Reads from `storefront_lever_recalibration` if M3 has shipped it; a no-op (no table /
 * no rows) otherwise — soft dependency on [[storefront-ltv-proxy-reconciler]] Phase 3.
 */
export async function applyReconcilerSignals(opts: { workspaceId: string; admin?: Admin; now?: Date }): Promise<ReconcilerResult> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();

  let signals: ReconcilerSignal[] = [];
  try {
    const { data, error } = await admin
      .from("storefront_lever_recalibration")
      .select("lever_key, chapter, product_id, lander_type, audience, adjust_factor, reason")
      .eq("workspace_id", opts.workspaceId)
      .eq("applied", false);
    if (error) return { signals: 0, adjusted: 0 }; // table absent / unreadable → no-op
    signals = (data as ReconcilerSignal[]) || [];
  } catch {
    return { signals: 0, adjusted: 0 };
  }
  if (signals.length === 0) return { signals: 0, adjusted: 0 };

  let adjusted = 0;
  for (const sig of signals) {
    // Resolve the lever(s) the signal targets.
    let leverIds: string[] = [];
    if (sig.lever_key) {
      const lev = await resolveLever(admin, sig.lever_key);
      if (lev) leverIds = [lev.id];
    } else if (sig.chapter) {
      const { data } = await admin.from("storefront_levers").select("id").eq("chapter", sig.chapter);
      leverIds = ((data as { id: string }[]) || []).map((r) => r.id);
    }
    if (leverIds.length === 0) continue;

    let q = admin.from("storefront_lever_importance").select("id, importance").eq("workspace_id", opts.workspaceId).in("lever_id", leverIds);
    if (sig.product_id) q = q.eq("product_id", sig.product_id);
    if (sig.lander_type) q = q.eq("lander_type", sig.lander_type);
    if (sig.audience) q = q.eq("audience", sig.audience);
    const { data: rows } = await q;
    for (const r of (rows as { id: string; importance: number }[]) || []) {
      const next = clamp01(r.importance * sig.adjust_factor);
      await admin.from("storefront_lever_importance").update({ importance: next, updated_at: now.toISOString() }).eq("id", r.id);
      adjusted++;
    }
  }
  return { signals: signals.length, adjusted };
}

export { ALL_LANDER_TYPES };
