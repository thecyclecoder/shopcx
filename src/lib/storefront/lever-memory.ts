/**
 * Storefront lever-importance memory — the persistent BRAIN of the storefront-optimizer
 * agent (docs/brain/specs/storefront-lever-importance-memory.md, M2).
 *
 * A hierarchical, LEARNED chapter→component lever-importance map: seeded with CRO
 * priors ([[storefront_levers]]) and updated to a posterior ([[storefront_lever_importance]])
 * by each completed M1 experiment ([[storefront-experiment-refresh]]). It's the
 * which-lever-to-test half of the two-level bandit.
 *
 * Core contracts (the spec's safety invariants):
 *   • Memory is APPEND-EVIDENCE, not destructive — a posterior update appends the
 *     contributing experiment to `evidence` and RECOMPUTES `importance` from
 *     prior + all evidence effects. A loss is recorded as much as a win.
 *   • IDEMPOTENT — each experiment updates a cell exactly once (deduped by
 *     experiment id in `evidence`); a re-run never double-counts.
 *   • DECAY keeps exploration alive — `importance` decays toward the prior as
 *     `last_tested_at` ages, so a written-off lever can resurrect and be re-probed.
 *   • SCOPED + transferable — every learning is tagged product_specific｜general;
 *     only `general` learnings seed a brand-new (product × lander × audience) cell.
 *   • The map is a TOOL, not the objective — it directs test budget; Growth + the
 *     M3 reconciler supervise it. A surprising swing is surfaced, not silently trusted.
 *
 * Pure math (effect / posterior / decay / score) is exported and DB-free for tests;
 * the DB I/O (updatePosterior, nextLeverToTest, decay pass) goes through
 * createAdminClient().
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { VariantRollupResult } from "@/lib/storefront/experiment-attribution";

type Admin = ReturnType<typeof createAdminClient>;

export type LanderType = "pdp" | "listicle" | "beforeafter" | "advertorial";
export type LeverScope = "product_specific" | "general";

// ── Tunables ──────────────────────────────────────────────────────────────────

/** The prior is weighed as this many pseudo-tests in the posterior mean — so a
 *  single experiment moves a never-tested lever but can't whipsaw it. */
export const PRIOR_STRENGTH = 2;
/** A relative predicted-LTV-proxy delta of this magnitude ⇒ a full "this lever
 *  matters" signal (effect = 1). 20% lift is a decisive CRO result. */
export const EFFECT_SCALE = 0.2;
/** Floor for the control's LTV-per-session denominator (cents) so a near-zero
 *  control doesn't explode the relative delta. */
export const LTV_PER_SESSION_FLOOR = 50;
/** Importance half-life: a posterior drifts halfway back to its prior every this
 *  many days untested — the re-probe clock. */
export const DECAY_HALF_LIFE_DAYS = 45;
/** Explore weight in nextLeverToTest's score (UCB-style uncertainty bonus). */
export const EXPLORE_C = 0.35;
/** Secondary weight the M5 campaign-grade signal adds to a lever's selection score — the
 *  CEO → Growth → Optimizer feedback bias. A high-graded lever pattern is nudged up, a
 *  low-graded one down, on a normalized [-1,1] scale around a neutral grade of 5.5. Kept
 *  small: grades SUPERVISE lever choice, they never override the learned proxy posterior. */
export const GRADE_BIAS_WEIGHT = 0.15;

// ── Pure math ───────────────────────────────────────────────────────────────

export interface EvidenceEntry {
  /** Experiment id (or `m3:<id>` for a reconciler signal) — the idempotency key. */
  experiment_id: string;
  /** Relative predicted-LTV-proxy delta (tested arm vs control). */
  proxy_delta: number;
  /** Derived [0,1] signal: how much this lever moved the proxy. */
  effect: number;
  /** Did the tested arm beat control on the proxy (a win) — informational. */
  won: boolean;
  /** 'experiment' | 'm3_reconciler'. */
  source: string;
  at: string;
}

/** Map a relative proxy delta to a [0,1] "this lever matters" effect. A meaningful
 *  move (either direction) means the lever IS a lever for this cell → raise it; a
 *  ~0 delta means it doesn't move the needle here → demote it. */
export function effectFromDelta(relDelta: number): number {
  return Math.min(1, Math.abs(relDelta) / EFFECT_SCALE);
}

/** Base posterior mean from the prior + all evidence effects (no decay). A Beta-style
 *  conjugate mean: prior counts as PRIOR_STRENGTH pseudo-observations. */
export function posteriorMean(prior: number, effects: number[]): number {
  const sum = effects.reduce((a, b) => a + b, 0);
  return (prior * PRIOR_STRENGTH + sum) / (PRIOR_STRENGTH + effects.length);
}

/** Decay a base posterior toward its prior given age. A written-off lever
 *  (base < prior) drifts UP toward prior (re-probeable); a high lever drifts down. */
export function decayedImportance(base: number, prior: number, ageDays: number): number {
  const factor = Math.pow(0.5, Math.max(0, ageDays) / DECAY_HALF_LIFE_DAYS);
  const v = prior + (base - prior) * factor;
  return Math.min(1, Math.max(0, v));
}

/** Recompute a cell's current importance from its prior + evidence + age. */
export function recomputeImportance(prior: number, evidence: EvidenceEntry[], ageDays: number): number {
  const base = posteriorMean(prior, evidence.map((e) => e.effect));
  return decayedImportance(base, prior, ageDays);
}

function daysBetween(from: Date | null, to: Date): number {
  if (!from) return 0;
  return Math.max(0, (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function ltvPerSession(r: VariantRollupResult): number {
  return r.sessions > 0 ? r.ltv_proxy_cents / r.sessions : 0;
}

// ── DB types ────────────────────────────────────────────────────────────────

interface LeverRow {
  id: string;
  lever_key: string;
  chapter: string;
  kind: "chapter" | "component";
  prior: number;
  lander_types: string[];
  default_scope: LeverScope;
}

export interface ImportanceRow {
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
  scope: LeverScope;
  seeded_from: string;
}

async function getLeverByKey(admin: Admin, leverKey: string): Promise<LeverRow | null> {
  const { data } = await admin
    .from("storefront_levers")
    .select("id, lever_key, chapter, kind:level, prior, lander_types, default_scope")
    .eq("lever_key", leverKey)
    .maybeSingle();
  return (data as LeverRow) ?? null;
}

/**
 * Resolve the prior + scope + provenance for a NEW (lever × product × lander × audience)
 * cell. Cross-product transfer: if the lever has `general` learnings on OTHER products,
 * seed from their average importance rather than the cold CRO prior.
 */
export async function seedCellPrior(
  admin: Admin,
  lever: LeverRow,
  productId: string,
  landerType: string,
): Promise<{ prior: number; scope: LeverScope; seeded_from: string }> {
  // Only general-scoped levers transfer; product-specific ones cold-start from the CRO prior.
  if (lever.default_scope === "general") {
    const { data } = await admin
      .from("storefront_lever_importance")
      .select("importance, lander_type, product_id")
      .eq("lever_id", lever.id)
      .eq("scope", "general")
      .neq("product_id", productId);
    const rows = (data as Array<{ importance: number; lander_type: string }>) || [];
    // Prefer same-lander-type general learnings; fall back to any.
    const sameLander = rows.filter((r) => r.lander_type === landerType);
    const pool = sameLander.length ? sameLander : rows;
    if (pool.length) {
      const avg = pool.reduce((a, r) => a + r.importance, 0) / pool.length;
      return { prior: avg, scope: "general", seeded_from: "general_transfer" };
    }
  }
  return { prior: lever.prior, scope: lever.default_scope, seeded_from: "cro_prior" };
}

// ── updatePosterior — commit one completed experiment's learning ──────────────

export interface CommittedLearning {
  lever_key: string;
  importance: number;
  prior: number;
  n_tests: number;
  proxy_delta: number;
  effect: number;
  won: boolean;
  idempotent_skip: boolean;
  scope: LeverScope;
}

/**
 * Consume a COMPLETED M1 experiment outcome and Bayesian-update the tested lever's
 * importance for its (product × lander × audience) cell. The reward is the predicted-
 * LTV-proxy delta (tested arm vs control) — a meaningful lift raises importance, a ~0
 * delta demotes it. Append-evidence + idempotent (deduped by experiment id).
 *
 * Pass the experiment's variant rollups so we don't re-query attribution.
 * Returns null when the experiment's `lever` doesn't map to a known lever_key.
 */
export async function updatePosterior(opts: {
  workspaceId: string;
  experiment: {
    id: string;
    product_id: string;
    lander_type: string;
    audience: string;
    lever: string;
  };
  rollups: VariantRollupResult[];
  now?: Date;
  admin?: Admin;
}): Promise<CommittedLearning | null> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  const { experiment } = opts;

  const lever = await getLeverByKey(admin, experiment.lever);
  if (!lever) {
    console.warn(`[lever-memory] no lever taxonomy match for lever='${experiment.lever}' — skipping learning (exp=${experiment.id})`);
    return null;
  }

  // Reward = relative predicted-LTV-proxy delta of the best non-control arm vs control.
  const control = opts.rollups.find((r) => r.is_control);
  const arms = opts.rollups.filter((r) => !r.is_control);
  const controlLtv = control ? ltvPerSession(control) : 0;
  const bestArm = arms.sort((a, b) => ltvPerSession(b) - ltvPerSession(a))[0];
  const bestLtv = bestArm ? ltvPerSession(bestArm) : 0;
  const denom = Math.max(controlLtv, LTV_PER_SESSION_FLOOR);
  const proxyDelta = (bestLtv - controlLtv) / denom;
  const effect = effectFromDelta(proxyDelta);
  const won = proxyDelta > 0;

  // Resolve (or create) the cell, transferring from general learnings if brand-new.
  const { data: existing } = await admin
    .from("storefront_lever_importance")
    .select("id, prior, evidence, scope, seeded_from")
    .eq("lever_id", lever.id)
    .eq("product_id", experiment.product_id)
    .eq("lander_type", experiment.lander_type)
    .eq("audience", experiment.audience)
    .maybeSingle();

  const entry: EvidenceEntry = {
    experiment_id: experiment.id,
    proxy_delta: Math.round(proxyDelta * 1000) / 1000,
    effect: Math.round(effect * 1000) / 1000,
    won,
    source: "experiment",
    at: now.toISOString(),
  };

  if (existing) {
    const row = existing as Pick<ImportanceRow, "id" | "prior" | "evidence" | "scope">;
    const evidence = Array.isArray(row.evidence) ? row.evidence : [];
    // Idempotent: this experiment already contributed → no double-count.
    if (evidence.some((e) => e.experiment_id === experiment.id)) {
      const importance = recomputeImportance(row.prior, evidence, 0);
      return {
        lever_key: lever.lever_key,
        importance,
        prior: row.prior,
        n_tests: evidence.length,
        proxy_delta: entry.proxy_delta,
        effect: entry.effect,
        won,
        idempotent_skip: true,
        scope: row.scope,
      };
    }
    const nextEvidence = [...evidence, entry];
    const importance = recomputeImportance(row.prior, nextEvidence, 0); // last_tested = now ⇒ no decay
    await admin
      .from("storefront_lever_importance")
      .update({
        importance,
        n_tests: nextEvidence.length,
        last_tested_at: now.toISOString(),
        evidence: nextEvidence,
        updated_at: now.toISOString(),
      })
      .eq("id", row.id);
    return {
      lever_key: lever.lever_key,
      importance,
      prior: row.prior,
      n_tests: nextEvidence.length,
      proxy_delta: entry.proxy_delta,
      effect: entry.effect,
      won,
      idempotent_skip: false,
      scope: row.scope,
    };
  }

  // Brand-new cell — seed prior (cross-product transfer if available), then record.
  const seed = await seedCellPrior(admin, lever, experiment.product_id, experiment.lander_type);
  const nextEvidence = [entry];
  const importance = recomputeImportance(seed.prior, nextEvidence, 0);
  await admin.from("storefront_lever_importance").insert({
    workspace_id: opts.workspaceId,
    lever_id: lever.id,
    product_id: experiment.product_id,
    lander_type: experiment.lander_type,
    audience: experiment.audience,
    importance,
    prior: seed.prior,
    n_tests: 1,
    last_tested_at: now.toISOString(),
    evidence: nextEvidence,
    scope: seed.scope,
    seeded_from: seed.seeded_from,
  });
  return {
    lever_key: lever.lever_key,
    importance,
    prior: seed.prior,
    n_tests: 1,
    proxy_delta: entry.proxy_delta,
    effect: entry.effect,
    won,
    idempotent_skip: false,
    scope: seed.scope,
  };
}

// ── Decay pass — re-probe clock ───────────────────────────────────────────────

/**
 * Decay every importance posterior toward its prior as `last_tested_at` ages, so a
 * written-off lever's posterior drifts back up enough to be re-probed later. Idempotent:
 * recomputes `importance` from prior + evidence + age each run (never compounds).
 */
export async function decayLeverImportance(opts: {
  workspaceId: string;
  now?: Date;
  admin?: Admin;
}): Promise<{ decayed: number }> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  const { data } = await admin
    .from("storefront_lever_importance")
    .select("id, prior, importance, evidence, last_tested_at")
    .eq("workspace_id", opts.workspaceId);
  const rows = (data as Array<Pick<ImportanceRow, "id" | "prior" | "importance" | "evidence" | "last_tested_at">>) || [];
  let decayed = 0;
  for (const row of rows) {
    const evidence = Array.isArray(row.evidence) ? row.evidence : [];
    const ageDays = daysBetween(row.last_tested_at ? new Date(row.last_tested_at) : null, now);
    const next = recomputeImportance(row.prior, evidence, ageDays);
    if (Math.abs(next - row.importance) < 1e-4) continue;
    await admin
      .from("storefront_lever_importance")
      .update({ importance: next, updated_at: now.toISOString() })
      .eq("id", row.id);
    decayed++;
  }
  return { decayed };
}

// ── M3 reconciler intake (cross-link, no hard dependency) ─────────────────────

/**
 * Read the M3 reconciler's recalibration signal (storefront_ltv_reconciliations) if
 * present and adjust the relevant levers' importance posteriors — e.g. a lever class
 * the slow loop finds systematically over/under-predicted (discount-heavy offers churn).
 * Best-effort: a no-op when M3 hasn't shipped its table. Append-evidence + idempotent
 * (keyed `m3:<reconciliation_id>`).
 */
export async function applyReconciliationSignal(opts: {
  workspaceId: string;
  now?: Date;
  admin?: Admin;
}): Promise<{ present: boolean; applied: number }> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  try {
    const { data, error } = await admin
      .from("storefront_ltv_reconciliations")
      .select("id, product_id, lander_type, audience, error_pct, lever_key")
      .eq("workspace_id", opts.workspaceId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return { present: false, applied: 0 };
    const recons = (data as Array<{
      id: string;
      product_id: string | null;
      lander_type: string | null;
      audience: string | null;
      error_pct: number | null;
      lever_key: string | null;
    }>) || [];
    let applied = 0;
    for (const rc of recons) {
      // Only act on a signal that names a lever class and a material error.
      if (!rc.lever_key || rc.error_pct == null || Math.abs(rc.error_pct) < 0.2) continue;
      const lever = await getLeverByKey(admin, rc.lever_key);
      if (!lever) continue;
      // The proxy lied about this lever class ⇒ it matters MORE than the proxy thought
      // (a surprise the supervisor caught). Treat |error_pct| as the effect signal.
      const effect = Math.min(1, Math.abs(rc.error_pct));
      const expKey = `m3:${rc.id}`;
      let q = admin
        .from("storefront_lever_importance")
        .select("id, prior, evidence")
        .eq("lever_id", lever.id);
      if (rc.product_id) q = q.eq("product_id", rc.product_id);
      if (rc.lander_type) q = q.eq("lander_type", rc.lander_type);
      if (rc.audience) q = q.eq("audience", rc.audience);
      const { data: cells } = await q;
      for (const cell of (cells as Array<Pick<ImportanceRow, "id" | "prior" | "evidence">>) || []) {
        const evidence = Array.isArray(cell.evidence) ? cell.evidence : [];
        if (evidence.some((e) => e.experiment_id === expKey)) continue; // idempotent
        const nextEvidence: EvidenceEntry[] = [
          ...evidence,
          { experiment_id: expKey, proxy_delta: rc.error_pct, effect, won: rc.error_pct > 0, source: "m3_reconciler", at: now.toISOString() },
        ];
        const importance = recomputeImportance(cell.prior, nextEvidence, 0);
        await admin
          .from("storefront_lever_importance")
          .update({ importance, n_tests: nextEvidence.length, evidence: nextEvidence, last_tested_at: now.toISOString(), updated_at: now.toISOString() })
          .eq("id", cell.id);
        applied++;
      }
    }
    return { present: true, applied };
  } catch {
    return { present: false, applied: 0 };
  }
}

// ── nextLeverToTest — the which-lever-to-test selector (explore/exploit) ──────

export interface LeverCandidate {
  lever_id: string;
  lever_key: string;
  chapter: string;
  kind: "chapter" | "component";
  importance: number;
  prior: number;
  n_tests: number;
  scope: LeverScope;
  seeded_from: string;
  /** Days since this cell was last tested (Infinity-capped at a large number if never). */
  age_days: number;
  /** Combined explore/exploit score the selector ranks on. */
  score: number;
  /** Why this lever surfaced. */
  reason: "exploit" | "explore_never_tested" | "explore_decayed";
}

export interface NextLeverResult {
  product_id: string;
  lander_type: string;
  audience: string;
  /** The highest-value lever to test next (null only if the taxonomy is empty). */
  choice: LeverCandidate | null;
  /** All applicable component-level candidates, ranked. */
  candidates: LeverCandidate[];
}

/**
 * The which-lever-to-test half of the two-level bandit. Returns the highest-value
 * lever to test next for a (product × lander × audience): high posterior = exploit;
 * decayed / never-tested = explore. A brand-new cell with no posterior is seeded from
 * `general` cross-product learnings, not a cold prior.
 *
 * Ranks COMPONENT-level levers (the things you actually A/B) applicable to the lander.
 */
export async function nextLeverToTest(opts: {
  workspaceId: string;
  productId: string;
  landerType: string;
  audience?: string;
  /** Optional M5 campaign-grade bias: `lever_key → avg grade (1–10)`. When present, a lever's
   *  selection score is nudged by GRADE_BIAS_WEIGHT toward high-graded patterns — the
   *  Head-of-Growth feedback signal as a secondary weight on lever choice. Omit ⇒ no bias. */
  gradeBias?: Record<string, number>;
  now?: Date;
  admin?: Admin;
}): Promise<NextLeverResult> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  const audience = opts.audience ?? "all";

  // Component-level levers applicable to this lander type.
  const { data: leverData } = await admin
    .from("storefront_levers")
    .select("id, lever_key, chapter, kind:level, prior, lander_types, default_scope")
    .eq("level", "component");
  const levers = ((leverData as LeverRow[]) || []).filter((l) => l.lander_types.includes(opts.landerType));

  // Existing posteriors for this exact cell.
  const { data: impData } = await admin
    .from("storefront_lever_importance")
    .select("lever_id, importance, prior, n_tests, last_tested_at, scope, seeded_from")
    .eq("workspace_id", opts.workspaceId)
    .eq("product_id", opts.productId)
    .eq("lander_type", opts.landerType)
    .eq("audience", audience);
  const impByLever = new Map(
    ((impData as Array<Pick<ImportanceRow, "lever_id" | "importance" | "prior" | "n_tests" | "last_tested_at" | "scope" | "seeded_from">>) || []).map((r) => [r.lever_id, r]),
  );

  const totalTests = [...impByLever.values()].reduce((a, r) => a + r.n_tests, 0);
  const NEVER_AGE = 10 * DECAY_HALF_LIFE_DAYS; // a never-tested cell reads as maximally stale

  const candidates: LeverCandidate[] = [];
  for (const lever of levers) {
    const existing = impByLever.get(lever.id);
    let importance: number;
    let prior: number;
    let nTests: number;
    let scope: LeverScope;
    let seededFrom: string;
    let ageDays: number;
    if (existing) {
      prior = existing.prior;
      nTests = existing.n_tests;
      scope = existing.scope;
      seededFrom = existing.seeded_from;
      ageDays = daysBetween(existing.last_tested_at ? new Date(existing.last_tested_at) : null, now);
      // The stored column is decay-adjusted at every write (updatePosterior + the daily
      // decay cron), so it's the current belief.
      importance = existing.importance;
    } else {
      // No posterior — seed from general cross-product learnings or the cold prior.
      const seed = await seedCellPrior(admin, lever, opts.productId, opts.landerType);
      prior = seed.prior;
      scope = seed.scope;
      seededFrom = seed.seeded_from;
      nTests = 0;
      ageDays = NEVER_AGE;
      importance = seed.prior; // best current belief = the (possibly transferred) prior
    }

    // UCB-style score: exploit (importance) + explore (uncertainty: untested/stale) + the M5
    // campaign-grade bias (Growth supervision: favor high-graded lever patterns). The grade term
    // is normalized to [-1,1] around a neutral grade of 5.5, then scaled by GRADE_BIAS_WEIGHT.
    const exploreBonus = EXPLORE_C * Math.sqrt(Math.log(totalTests + 2) / (nTests + 1));
    const stalenessBonus = 0.2 * Math.min(1, ageDays / DECAY_HALF_LIFE_DAYS);
    const gradeAvg = opts.gradeBias?.[lever.lever_key];
    const gradeBonus = typeof gradeAvg === "number" ? GRADE_BIAS_WEIGHT * Math.max(-1, Math.min(1, (gradeAvg - 5.5) / 4.5)) : 0;
    const score = importance + exploreBonus + stalenessBonus + gradeBonus;
    const reason: LeverCandidate["reason"] =
      nTests === 0 ? "explore_never_tested" : ageDays >= DECAY_HALF_LIFE_DAYS ? "explore_decayed" : "exploit";

    candidates.push({
      lever_id: lever.id,
      lever_key: lever.lever_key,
      chapter: lever.chapter,
      kind: lever.kind,
      importance: Math.round(importance * 1000) / 1000,
      prior: Math.round(prior * 1000) / 1000,
      n_tests: nTests,
      scope,
      seeded_from: seededFrom,
      age_days: Math.round(ageDays * 10) / 10,
      score: Math.round(score * 1000) / 1000,
      reason,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return {
    product_id: opts.productId,
    lander_type: opts.landerType,
    audience,
    choice: candidates[0] ?? null,
    candidates,
  };
}

// ── Funnel-data chapter priors (Phase 1 refinement) ──────────────────────────

/**
 * Recompute chapter-level importance priors from the REAL funnel data we already have:
 * per-chapter dwell share + scroll-to-price CTA-click share from [[storefront_events]]
 * (`chapter_dwell` / `cta_click`). Returns a `chapter → prior` map normalized so the
 * top chapter ~= 0.9 (hero-dominant), matching the seeded CRO ranking. Pure read.
 */
export async function computeChapterPriorsFromFunnel(opts: {
  workspaceId: string;
  sinceDays?: number;
  admin?: Admin;
}): Promise<Record<string, number>> {
  const admin = opts.admin ?? createAdminClient();
  const dwellByChapter = new Map<string, number>();
  const ctaByChapter = new Map<string, number>();
  const PAGE = 1000;
  const MAX_PAGES = 50;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await admin
      .from("storefront_events")
      .select("event_type, meta")
      .eq("workspace_id", opts.workspaceId)
      .in("event_type", ["chapter_dwell", "cta_click"])
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    const batch = (data as Array<{ event_type: string; meta: Record<string, unknown> }>) || [];
    for (const r of batch) {
      const m = r.meta || {};
      const chapter = typeof m.chapter === "string" ? m.chapter : null;
      if (!chapter) continue;
      if (r.event_type === "chapter_dwell") {
        const ms = typeof m.dwell_ms === "number" ? m.dwell_ms : 0;
        dwellByChapter.set(chapter, (dwellByChapter.get(chapter) ?? 0) + ms);
      } else if (r.event_type === "cta_click" && m.cta_kind === "scroll_to_price") {
        ctaByChapter.set(chapter, (ctaByChapter.get(chapter) ?? 0) + 1);
      }
    }
    if (batch.length < PAGE) break;
  }
  const chapters = new Set<string>([...dwellByChapter.keys(), ...ctaByChapter.keys()]);
  const totalDwell = [...dwellByChapter.values()].reduce((a, b) => a + b, 0) || 1;
  const totalCta = [...ctaByChapter.values()].reduce((a, b) => a + b, 0) || 1;
  // Blend dwell share + CTA share (CTA weighted higher — it's intent, not just attention).
  const raw = new Map<string, number>();
  for (const c of chapters) {
    const dwellShare = (dwellByChapter.get(c) ?? 0) / totalDwell;
    const ctaShare = (ctaByChapter.get(c) ?? 0) / totalCta;
    raw.set(c, 0.4 * dwellShare + 0.6 * ctaShare);
  }
  const max = Math.max(...raw.values(), 1e-9);
  const out: Record<string, number> = {};
  for (const [c, v] of raw) out[c] = Math.round((0.9 * (v / max)) * 1000) / 1000;
  return out;
}

/**
 * Apply funnel-data-derived chapter priors onto the chapter-level [[storefront_levers]]
 * rows (Phase 1 seeding from real funnel data). Idempotent. Only mutates with apply=true.
 */
export async function seedChapterPriorsFromFunnel(opts: {
  workspaceId: string;
  apply?: boolean;
  admin?: Admin;
}): Promise<{ priors: Record<string, number>; updated: number }> {
  const admin = opts.admin ?? createAdminClient();
  const priors = await computeChapterPriorsFromFunnel({ workspaceId: opts.workspaceId, admin });
  let updated = 0;
  if (opts.apply) {
    for (const [chapter, prior] of Object.entries(priors)) {
      const { data } = await admin
        .from("storefront_levers")
        .update({ prior, updated_at: new Date().toISOString() })
        .eq("level", "chapter")
        .eq("lever_key", chapter)
        .select("id");
      updated += (data as unknown[] | null)?.length ?? 0;
    }
  }
  return { priors, updated };
}

// ── Dashboard read — "what the agent believes matters" ────────────────────────

export interface LeverImportancePanelRow {
  lever_key: string;
  chapter: string;
  kind: "chapter" | "component";
  product_id: string;
  lander_type: string;
  audience: string;
  importance: number;
  prior: number;
  n_tests: number;
  scope: LeverScope;
  last_tested_at: string | null;
}

/**
 * Best-effort read of the current importance posteriors for the funnel dashboard's
 * "what the agent believes matters" panel. Empty if the tables aren't present yet.
 */
export async function getLeverImportancePanel(admin: Admin, workspaceId: string): Promise<LeverImportancePanelRow[]> {
  type ImpCell = {
    lever_id: string;
    product_id: string;
    lander_type: string;
    audience: string;
    importance: number;
    prior: number;
    n_tests: number;
    scope: LeverScope;
    last_tested_at: string | null;
  };
  try {
    const { data: imp } = await admin
      .from("storefront_lever_importance")
      .select("lever_id, product_id, lander_type, audience, importance, prior, n_tests, scope, last_tested_at")
      .eq("workspace_id", workspaceId)
      .order("importance", { ascending: false })
      .limit(200);
    const rows = (imp as ImpCell[]) || [];
    if (!rows.length) return [];
    const leverIds = [...new Set(rows.map((r) => r.lever_id))];
    const { data: levers } = await admin
      .from("storefront_levers")
      .select("id, lever_key, chapter, kind:level")
      .in("id", leverIds);
    const leverById = new Map(((levers as Array<{ id: string; lever_key: string; chapter: string; kind: "chapter" | "component" }>) || []).map((l) => [l.id, l]));
    return rows
      .map((lr) => {
        const lever = leverById.get(lr.lever_id);
        if (!lever) return null;
        return {
          lever_key: lever.lever_key,
          chapter: lever.chapter,
          kind: lever.kind,
          product_id: lr.product_id,
          lander_type: lr.lander_type,
          audience: lr.audience,
          importance: lr.importance,
          prior: lr.prior,
          n_tests: lr.n_tests,
          scope: lr.scope,
          last_tested_at: lr.last_tested_at,
        } as LeverImportancePanelRow;
      })
      .filter((r): r is LeverImportancePanelRow => r !== null);
  } catch {
    return [];
  }
}
