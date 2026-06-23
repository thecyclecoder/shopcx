/**
 * Storefront experiment assignment + content patching — Phase 2 of the
 * storefront experiment + bandit framework
 * (docs/brain/specs/storefront-experiment-bandit-framework.md).
 *
 * This is the read-side library the lander render path consumes:
 *   • `assignVariant` — DETERMINISTIC, STICKY per-identity assignment of an
 *     experiment's arm (or its control/holdout). A given identity
 *     (`customer_id ?? anonymous_id`) sees ONE arm for the life of the
 *     experiment — it hashes a stable key, so it never flips arms mid-run.
 *   • `applyVariantPatch` — applies a variant's reversible content patch over the
 *     DB-driven lander content ([[advertorial_pages]] → AdvertorialContent).
 *   • `resolveExperimentsForRender` — the one call the storefront route makes:
 *     loads the active experiments for a (product, lander_type), assigns the
 *     visitor, patches the content, and returns the `experiment_exposure` rows the
 *     client pixel will emit.
 *
 * Stickiness model (why no DB-persisted assignment is needed): the per-identity
 * bucketing is a pure function of `hash(identity + experiment_id)`, so it's stable
 * across requests without storing anything. The bandit ([[storefront-bandit]])
 * drives DISCRETE reallocation — promote (shift non-holdout traffic to the winner)
 * / kill / rollback (stop serving) — not a continuous per-request re-bucket, so a
 * visitor's arm doesn't wobble as posteriors update. The holdout band is reserved
 * first and never reallocated (holdout is sacred).
 */
import { createHash } from "crypto";
import type { AdvertorialContent, AdvertorialVariant } from "@/lib/advertorial-pages";
import type { createAdminClient } from "@/lib/supabase/admin";

export type ExperimentStatus = "draft" | "running" | "promoted" | "killed" | "rolled_back";
export type LanderType = "pdp" | "listicle" | "beforeafter" | "advertorial";

/** The reversible content patch a variant applies over the DB-driven lander. Every
 *  field is optional; an absent field means "use the control content". Copy / hero /
 *  chapter only — NEVER a code deploy or an offer/pricing change. */
export interface VariantPatch {
  headline?: string;
  dek?: string;
  publication?: string;
  sponsorLabel?: string;
  heroCaption?: string;
  /** Override the hero image (a public URL or re-signable path the reader resolves). */
  heroImageUrl?: string;
  chapterHeading?: string;
  chapterParagraphs?: string[];
  /** Reorder the existing chapter paragraphs by index (add/remove/reorder). */
  chapterOrder?: number[];
  /** Reorder the existing "reasons" listicle items by index. */
  reasonsOrder?: number[];
}

export interface ExperimentRow {
  id: string;
  workspace_id: string;
  product_id: string;
  lander_type: LanderType;
  audience: string;
  lever: string;
  status: ExperimentStatus;
  holdout_pct: number;
  promoted_variant_id: string | null;
}

export interface VariantRow {
  id: string;
  experiment_id: string;
  workspace_id: string;
  label: string;
  is_control: boolean;
  patch: VariantPatch;
  alpha: number;
  beta: number;
  reward_sum: number;
  n: number;
  sessions: number;
  conversions: number;
  sub_attach: number;
  revenue_cents: number;
  ltv_proxy_cents: number;
}

/** The exposure payload the client pixel emits as a `experiment_exposure` event. */
export interface ExperimentExposureMeta {
  experiment_id: string;
  variant_id: string;
  is_holdout: boolean;
  product_id: string;
}

export interface Assignment {
  variant: VariantRow;
  isHoldout: boolean;
}

type Admin = ReturnType<typeof createAdminClient>;

/** Conservative mode reserves most non-holdout traffic for control until M3
 *  calibrates the LTV proxy — "smaller bets" per the goal's conservative rule. */
export const CONSERVATIVE_EXPLORE_SHARE = 0.34;

/** Map the storefront render `?variant=` to an experiment `lander_type`. */
export function landerTypeForVariant(variant: AdvertorialVariant): LanderType {
  return variant === "reasons" ? "listicle" : variant;
}

/** Map an experiment `lander_type` → the storefront render `?variant=` that renders
 *  it. Inverse of `landerTypeForVariant`; `pdp` has no advertorial render variant, so
 *  the detail-page preview falls back to `advertorial` (the patch fields are
 *  advertorial content). Used to build the owner-only preview link. */
export function renderVariantForLanderType(landerType: LanderType): AdvertorialVariant {
  if (landerType === "listicle") return "reasons";
  if (landerType === "beforeafter") return "beforeafter";
  return "advertorial";
}

/** Parse the detail-page preview param `sx_preview=<experimentId>:<variantId>` into
 *  its parts. Returns null for any malformed value. */
export function parsePreviewParam(
  raw: string | null | undefined,
): { experimentId: string; variantId: string } | null {
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx <= 0) return null;
  const experimentId = raw.slice(0, idx).trim();
  const variantId = raw.slice(idx + 1).trim();
  if (!experimentId || !variantId) return null;
  return { experimentId, variantId };
}

/** Stable hash of a string → a unit float in [0,1). Deterministic across processes
 *  (sha256), so assignment is sticky without persisting anything. */
export function hashToUnit(key: string): number {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return parseInt(hex, 16) / 0x100000000;
}

/**
 * Deterministically assign an identity to an arm of an experiment (or its
 * control/holdout). Sticky: the same `(identityKey, experiment.id)` always lands on
 * the same arm for a given experiment status.
 *
 *   • holdout band  [0, holdout_pct)        → control, isHoldout=true   (sacred — never reallocated)
 *   • promoted       → the rest             → the promoted variant       (winner serves all non-holdout)
 *   • running        → explore band         → non-control arms, equal split
 *                       remainder           → control, isHoldout=false   (conservative reserves more here)
 *
 * Returns null only when there's no usable control arm (malformed experiment).
 */
export function assignVariant(
  identityKey: string,
  experiment: ExperimentRow,
  variants: VariantRow[],
  opts: { conservative?: boolean } = {},
): Assignment | null {
  const control = variants.find((v) => v.is_control) ?? null;
  if (!control) return null;

  const u = hashToUnit(`${identityKey}:${experiment.id}`);
  const holdout = Math.min(Math.max(experiment.holdout_pct ?? 0, 0), 1);

  // Holdout band — reserved first, never reallocated by the bandit.
  if (u < holdout) return { variant: control, isHoldout: true };

  // Promoted: the winning arm serves all non-holdout traffic.
  if (experiment.status === "promoted" && experiment.promoted_variant_id) {
    const winner = variants.find((v) => v.id === experiment.promoted_variant_id) ?? control;
    return { variant: winner, isHoldout: false };
  }

  // Running: split the non-holdout band between the explore arms and control.
  const arms = variants.filter((v) => !v.is_control);
  if (arms.length === 0) return { variant: control, isHoldout: false };

  // Renormalize the position within the non-holdout band to [0,1).
  const r = holdout < 1 ? (u - holdout) / (1 - holdout) : 0;
  const exploreShare = opts.conservative ? CONSERVATIVE_EXPLORE_SHARE : 1;
  if (r >= exploreShare) return { variant: control, isHoldout: false };

  const idx = Math.min(arms.length - 1, Math.floor((r / exploreShare) * arms.length));
  return { variant: arms[idx], isHoldout: false };
}

/** Apply a variant's reversible content patch over the control lander content. */
export function applyVariantPatch(content: AdvertorialContent, patch: VariantPatch | null | undefined): AdvertorialContent {
  if (!patch || Object.keys(patch).length === 0) return content;
  const next: AdvertorialContent = { ...content, chapter: { ...content.chapter } };

  if (patch.headline) next.headline = patch.headline;
  if (patch.dek) next.dek = patch.dek;
  if (patch.publication) next.publication = patch.publication;
  if (patch.sponsorLabel) next.sponsorLabel = patch.sponsorLabel;
  if (patch.heroCaption) next.heroCaption = patch.heroCaption;
  if (patch.heroImageUrl) next.heroImageUrl = patch.heroImageUrl;
  if (patch.chapterHeading) next.chapter.heading = patch.chapterHeading;
  if (patch.chapterParagraphs?.length) next.chapter.paragraphs = patch.chapterParagraphs;
  else if (patch.chapterOrder?.length) next.chapter.paragraphs = reorder(content.chapter.paragraphs, patch.chapterOrder);
  if (patch.reasonsOrder?.length) next.reasons = reorder(content.reasons, patch.reasonsOrder);

  return next;
}

/** Reorder/select array items by a list of indexes; out-of-range indexes are dropped. */
function reorder<T>(items: T[], order: number[]): T[] {
  const out: T[] = [];
  for (const i of order) {
    if (i >= 0 && i < items.length) out.push(items[i]);
  }
  return out.length ? out : items;
}

/** Load the active (running|promoted) experiments + their variants for a lander.
 *  Best-effort: returns [] if the tables don't exist yet (pre-migration). */
export async function loadActiveExperiments(
  admin: Admin,
  workspaceId: string,
  productId: string,
  landerType: LanderType,
): Promise<Array<{ experiment: ExperimentRow; variants: VariantRow[] }>> {
  try {
    const { data: experiments } = await admin
      .from("storefront_experiments")
      .select("id, workspace_id, product_id, lander_type, audience, lever, status, holdout_pct, promoted_variant_id")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .eq("lander_type", landerType)
      .in("status", ["running", "promoted"]);
    if (!experiments?.length) return [];

    const { data: variants } = await admin
      .from("storefront_experiment_variants")
      .select(
        "id, experiment_id, workspace_id, label, is_control, patch, alpha, beta, reward_sum, n, sessions, conversions, sub_attach, revenue_cents, ltv_proxy_cents",
      )
      .in(
        "experiment_id",
        experiments.map((e) => e.id),
      );
    const byExperiment = new Map<string, VariantRow[]>();
    for (const v of (variants as VariantRow[]) || []) {
      const arr = byExperiment.get(v.experiment_id) ?? [];
      arr.push(v);
      byExperiment.set(v.experiment_id, arr);
    }
    return (experiments as ExperimentRow[])
      .map((experiment) => ({ experiment, variants: byExperiment.get(experiment.id) ?? [] }))
      .filter((e) => e.variants.some((v) => v.is_control));
  } catch {
    return []; // tables not present yet — degrade gracefully
  }
}

/** Load ONE experiment + its variants by id (any status), for the owner-only
 *  detail-page preview. Unlike `loadActiveExperiments` this isn't status-gated — the
 *  owner can preview an arm of a paused/promoted/killed experiment too. Returns null
 *  if the experiment isn't in this workspace or has no control arm. */
export async function loadExperimentById(
  admin: Admin,
  workspaceId: string,
  experimentId: string,
): Promise<{ experiment: ExperimentRow; variants: VariantRow[] } | null> {
  try {
    const { data: experiment } = await admin
      .from("storefront_experiments")
      .select("id, workspace_id, product_id, lander_type, audience, lever, status, holdout_pct, promoted_variant_id")
      .eq("workspace_id", workspaceId)
      .eq("id", experimentId)
      .maybeSingle();
    if (!experiment) return null;

    const { data: variants } = await admin
      .from("storefront_experiment_variants")
      .select(
        "id, experiment_id, workspace_id, label, is_control, patch, alpha, beta, reward_sum, n, sessions, conversions, sub_attach, revenue_cents, ltv_proxy_cents",
      )
      .eq("experiment_id", experimentId);
    const arms = (variants as VariantRow[]) || [];
    if (!arms.some((v) => v.is_control)) return null;
    return { experiment: experiment as ExperimentRow, variants: arms };
  } catch {
    return null;
  }
}

/**
 * The single call the storefront lander render makes. Resolves every active
 * experiment for this (product, lander_type), sticky-assigns the visitor, patches
 * the content, and returns the `experiment_exposure` rows the client pixel emits.
 *
 * No identity (null cookie) → no experiments served (we can't sticky-assign), and
 * the un-patched control content renders.
 *
 * PREVIEW MODE (`opts.preview`): the owner-only detail-page preview link
 * (`?sx_preview=<experimentId>:<variantId>`) FORCES that one arm's patch regardless
 * of sticky assignment or identity, so the owner sees exactly what a shopper in that
 * arm sees (control = current hero; variant = the generated hero). The link also
 * carries `sx_internal=1`, so the emitted exposure is dropped at the pixel write —
 * the bandit is never polluted (the existing internal-traffic exclusion).
 */
export async function resolveExperimentsForRender(opts: {
  admin: Admin;
  workspaceId: string;
  productId: string;
  renderVariant: AdvertorialVariant;
  identityKey: string | null;
  content: AdvertorialContent;
  conservative?: boolean;
  preview?: { experimentId: string; variantId: string } | null;
}): Promise<{ content: AdvertorialContent; exposures: ExperimentExposureMeta[] }> {
  const { admin, workspaceId, productId, renderVariant, identityKey, content, preview } = opts;

  // Preview: force the requested arm. No identity needed (assignment is bypassed).
  if (preview) {
    const loaded = await loadExperimentById(admin, workspaceId, preview.experimentId);
    if (!loaded || loaded.experiment.product_id !== productId) return { content, exposures: [] };
    const arm = loaded.variants.find((v) => v.id === preview.variantId);
    if (!arm) return { content, exposures: [] };
    return {
      content: applyVariantPatch(content, arm.patch),
      exposures: [
        {
          experiment_id: loaded.experiment.id,
          variant_id: arm.id,
          is_holdout: arm.is_control,
          product_id: productId,
        },
      ],
    };
  }

  if (!identityKey) return { content, exposures: [] };

  const landerType = landerTypeForVariant(renderVariant);
  const active = await loadActiveExperiments(admin, workspaceId, productId, landerType);
  if (!active.length) return { content, exposures: [] };

  let patched = content;
  const exposures: ExperimentExposureMeta[] = [];
  for (const { experiment, variants } of active) {
    const assignment = assignVariant(identityKey, experiment, variants, { conservative: opts.conservative });
    if (!assignment) continue;
    patched = applyVariantPatch(patched, assignment.variant.patch);
    exposures.push({
      experiment_id: experiment.id,
      variant_id: assignment.variant.id,
      is_holdout: assignment.isHoldout,
      product_id: productId,
    });
  }
  return { content: patched, exposures };
}
