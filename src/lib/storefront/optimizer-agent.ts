/**
 * The Storefront Optimizer agent — campaign loop + build-or-request (M4 of the
 * storefront-optimizer goal, docs/brain/specs/storefront-optimizer-agent.md).
 *
 * The capstone that ties the foundations together. This module is the DETERMINISTIC
 * half of the agent — the read-only brief loader the box `claude -p` reasons over, the
 * dedup + enqueue discipline its scheduling cron honors, and the WRITE the worker
 * materializes from the agent's typed plan (the box session itself stays read-only,
 * mirroring [[migration-fix]] / [[repair-agent]] — it DIAGNOSES + PROPOSES, the worker
 * executes on the gate's verdict).
 *
 * The campaign loop, one campaign = one hypothesis = one atomic lever:
 *   1. read state — the funnel ([[storefront-lever-memory]] `computeChapterPriorsFromFunnel`),
 *      the lever-importance map (M2 `nextLeverToTest`), the predicted-LTV proxy (M3
 *      `storefront_ltv_metrics`), the activation policy (the gate), and the live lander.
 *   2. form ONE grounded, CRO-reasoned hypothesis (the box session does this).
 *   3. materialize the variant + stand up an M1 experiment vs holdout (`materializeCampaign`).
 *   4. decide → learn → report — already wired in the M1 refresh
 *      ([[storefront-experiment-refresh]] `commitLearning` → M2 `updatePosterior`); the
 *      experiment row IS the campaign record M5 grades.
 *   5. missing capability → author a scoped spec + surface for owner Build (never fake,
 *      never silent auto-build — the [[repair-agent]] surface-don't-auto-build pattern).
 *
 * Governance (the north star — CEO → Growth → Optimizer): every campaign passes the
 * [[optimizer-policy]] gate first (off-by-default, product-scoped, propose-and-approve
 * unless a reversible lever is explicitly opted into auto-run); offers + structural
 * rewrites are ALWAYS approval-gated; the agent runs conservatively (smaller exposed
 * bet) until M3 has calibrated the proxy once.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { generateNanoBananaProCombine } from "@/lib/gemini";
import { compressToWebp } from "@/lib/blog/generate-images";
import {
  loadOptimizerPolicy,
  evaluateProposalGate,
  type OptimizerPolicy,
  type LeverClass,
  type ProposalGate,
} from "@/lib/storefront/optimizer-policy";
import {
  nextLeverToTest,
  computeChapterPriorsFromFunnel,
  type LeverCandidate,
  type LanderType,
} from "@/lib/storefront/lever-memory";
import { getCalibrationState } from "@/lib/storefront/calibration";
import type { VariantPatch } from "@/lib/storefront/experiments";
import {
  proposeOffer,
  activateOffer,
  DEFAULT_RENEWAL_MARGIN_FLOOR_PCT,
  type OfferType,
  type OfferPlan,
} from "@/lib/storefront/renewal-offers";

type Admin = ReturnType<typeof createAdminClient>;

// ── Tunables ──────────────────────────────────────────────────────────────────

/** The four lander surfaces the optimizer covers (the spec's scope). */
export const LANDER_TYPES: LanderType[] = ["pdp", "listicle", "beforeafter", "advertorial"];
/** Audiences the scheduler fans out over. Kept to the workspace-grain default for now
 *  ('all') — M3's est-sub-LTV isn't audience-segmentable yet, so finer audiences would
 *  just split traffic without a distinct reward. Widen when audience-tagged LTV lands. */
export const OPTIMIZER_AUDIENCES = ["all"];
/** A surface is only DUE for a campaign when its next-best lever scores at least this —
 *  below it there's no worthwhile bet, so we stay idle rather than churn experiments. */
export const MIN_LEVER_SCORE_TO_TEST = 0.35;
/** Statuses that count as a live optimizer job (dedup ≤1 active campaign per surface). */
export const LIVE_OPTIMIZER_STATUSES = [
  "queued",
  "claimed",
  "building",
  "needs_input",
  "needs_approval",
  "queued_resume",
  "blocked_on_usage",
] as const;
/** Experiment statuses that occupy a surface (so we never stand up a second). */
export const ACTIVE_EXPERIMENT_STATUSES = ["draft", "running", "promoted"] as const;
/** Conservative mode (M3 not calibrated) reserves a bigger holdout — a smaller exposed
 *  bet — on top of whatever the policy / proposal asks for. */
export const CONSERVATIVE_MIN_HOLDOUT = 0.2;
/** Bucket the optimizer's generated heroes land in (re-signable, same as the lander heroes). */
const OPTIMIZER_HERO_BUCKET = "product-media";
/** Lever keys that are OFFER-class (M6 persist-to-renewal offers) — ALWAYS owner-approved,
 *  routed via the offer path (proposeOptimizerOffer), never the autonomous content/coupon one. */
export const OFFER_LEVER_KEYS = new Set<string>(["renewal_offer"]);

// ── Types ───────────────────────────────────────────────────────────────────

/** One (product × lander-type × audience) the scheduler / worker operates on. */
export interface OptimizerSurface {
  workspace_id: string;
  product_id: string;
  lander_type: LanderType;
  audience: string;
}

/** Build the deterministic dedup/spec key for a surface (the agent_jobs.spec_slug). */
export function surfaceKey(s: { product_id: string; lander_type: string; audience: string }): string {
  return `${s.product_id}:${s.lander_type}:${s.audience}`;
}

/** The variant the box session proposes — a reversible content patch, or a hero the
 *  worker generates from a prompt (the box never calls the image API itself). */
export interface OptimizerVariantPlan {
  label: string;
  kind: "content" | "hero";
  /** Reversible content patch (copy / chapter add-remove-reorder). Used when kind='content'. */
  patch?: VariantPatch;
  /** Nano-Banana hero prompt. Used when kind='hero' — the WORKER generates + uploads it. */
  hero_prompt?: string;
}

/** The typed campaign plan the box session emits (status='propose'). */
export interface OptimizerProposal {
  hypothesis: string;
  /** Cites the funnel signal + the lever posterior it came from (surfaced reasoning). */
  reasoning: string;
  lever_key: string;
  lever_class: LeverClass;
  lander_type: LanderType;
  audience: string;
  holdout_pct?: number;
  variant: OptimizerVariantPlan;
}

/** The read-only brief the box session reasons over + the structured state the worker
 *  needs to gate + materialize the proposal. */
export interface OptimizerBrief {
  surface: OptimizerSurface;
  text: string;
  policy: OptimizerPolicy | null;
  gate: ProposalGate;
  candidates: LeverCandidate[];
  conservative: boolean;
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

/** Is a campaign already standing on this surface (a draft/running/promoted experiment)?
 *  ≤1 active campaign per surface — clean attribution. Best-effort (degrades to false). */
export async function hasActiveCampaignForSurface(admin: Admin, s: OptimizerSurface): Promise<boolean> {
  try {
    const { data } = await admin
      .from("storefront_experiments")
      .select("id")
      .eq("workspace_id", s.workspace_id)
      .eq("product_id", s.product_id)
      .eq("lander_type", s.lander_type)
      .eq("audience", s.audience)
      .in("status", ACTIVE_EXPERIMENT_STATUSES as unknown as string[])
      .limit(1);
    return !!(data && data.length);
  } catch {
    return false;
  }
}

/** Is an optimizer JOB already live for this surface (queue dedup, mirrors the repair-agent
 *  per-signature dedup)? */
async function hasLiveJobForSurface(admin: Admin, s: OptimizerSurface): Promise<boolean> {
  const { data } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("kind", "storefront-optimizer")
    .eq("spec_slug", surfaceKey(s))
    .in("status", LIVE_OPTIMIZER_STATUSES as unknown as string[])
    .limit(1);
  return !!(data && data.length);
}

// ── Enqueue (the scheduling cron's worker) ──────────────────────────────────────

export interface EnqueueResult {
  active: boolean;
  considered: number;
  enqueued: number;
  surfaces: string[];
}

/**
 * Enqueue one campaign cycle per DUE (product × lander-type × audience) for a workspace.
 * Off unless the optimizer policy is active. A surface is due only when:
 *   • it's in the policy product_scope (enforced by the gate downstream too), AND
 *   • no active campaign (experiment) already stands on it, AND
 *   • no optimizer job is already live for it (queue dedup), AND
 *   • its next-best lever clears MIN_LEVER_SCORE_TO_TEST (a worthwhile bet exists).
 * Deduped + bounded — the [[repair-agent]] / [[box-escalation-triage]] enqueue discipline.
 */
export async function enqueueDueCampaigns(opts: {
  workspaceId: string;
  now?: Date;
  admin?: Admin;
}): Promise<EnqueueResult> {
  const admin = opts.admin ?? createAdminClient();
  const policy = await loadOptimizerPolicy(admin, opts.workspaceId);
  if (!policy?.active) return { active: false, considered: 0, enqueued: 0, surfaces: [] };

  let considered = 0;
  let enqueued = 0;
  const enqueuedSurfaces: string[] = [];

  for (const product_id of policy.product_scope) {
    for (const lander_type of LANDER_TYPES) {
      for (const audience of OPTIMIZER_AUDIENCES) {
        considered++;
        const surface: OptimizerSurface = { workspace_id: opts.workspaceId, product_id, lander_type, audience };
        if (await hasActiveCampaignForSurface(admin, surface)) continue;
        if (await hasLiveJobForSurface(admin, surface)) continue;

        const next = await nextLeverToTest({
          workspaceId: opts.workspaceId,
          productId: product_id,
          landerType: lander_type,
          audience,
          now: opts.now,
          admin,
        });
        if (!next.choice || next.choice.score < MIN_LEVER_SCORE_TO_TEST) continue;

        const { error } = await admin.from("agent_jobs").insert({
          workspace_id: opts.workspaceId,
          spec_slug: surfaceKey(surface),
          kind: "storefront-optimizer",
          status: "queued",
          instructions: JSON.stringify({
            workspace_id: opts.workspaceId,
            product_id,
            lander_type,
            audience,
            lever_key: next.choice.lever_key,
            lever_reason: next.choice.reason,
          }),
        });
        if (!error) {
          enqueued++;
          enqueuedSurfaces.push(surfaceKey(surface));
        } else {
          console.warn(`[storefront-optimizer] enqueue failed ${surfaceKey(surface)}: ${error.message}`);
        }
      }
    }
  }
  return { active: true, considered, enqueued, surfaces: enqueuedSurfaces };
}

// ── Brief (read-only state the box session reasons over) ────────────────────────

/** A short summary of the live lander content the agent may patch (best-effort). */
async function loadCurrentLanderSummary(admin: Admin, productId: string): Promise<string> {
  try {
    const { data } = await admin
      .from("advertorial_pages")
      .select("variant, headline, dek, chapter_heading, chapter_paragraphs, reasons, status")
      .eq("product_id", productId)
      .eq("status", "ready")
      .limit(6);
    const rows = (data as Array<Record<string, unknown>>) || [];
    if (!rows.length) return "  (no ready advertorial_pages rows — PDP/default content only)";
    return rows
      .map((r) => {
        const paras = Array.isArray(r.chapter_paragraphs) ? (r.chapter_paragraphs as string[]) : [];
        const reasons = Array.isArray(r.reasons) ? (r.reasons as unknown[]) : [];
        return [
          `  • variant=${r.variant} headline="${String(r.headline ?? "").slice(0, 90)}"`,
          `    dek="${String(r.dek ?? "").slice(0, 90)}"`,
          `    chapter="${String(r.chapter_heading ?? "").slice(0, 60)}" (${paras.length} paragraph(s), ${reasons.length} reason(s))`,
        ].join("\n");
      })
      .join("\n");
  } catch {
    return "  (lander content unavailable)";
  }
}

/** Latest predicted-LTV-per-visitor snapshot for the surface (the reward the agent moves). */
async function loadLatestLtv(admin: Admin, s: OptimizerSurface): Promise<Record<string, unknown> | null> {
  try {
    const { data } = await admin
      .from("storefront_ltv_metrics")
      .select("visitors, sub_attach_rate, predicted_ltv_per_visitor_cents, snapshot_date, calibrated")
      .eq("workspace_id", s.workspace_id)
      .eq("product_id", s.product_id)
      .eq("lander_type", s.lander_type)
      .eq("audience", s.audience)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

/**
 * Load the read-only campaign brief for a surface: the activation gate, the next-best
 * lever + ranked candidates (M2), the funnel chapter signal, the predicted-LTV proxy
 * (M3) + calibration state, and the live lander content. The box session reasons over
 * the TEXT; the worker gates + materializes from the STRUCTURED fields.
 */
export async function loadOptimizerBrief(opts: {
  surface: OptimizerSurface;
  now?: Date;
  admin?: Admin;
}): Promise<OptimizerBrief> {
  const admin = opts.admin ?? createAdminClient();
  const s = opts.surface;

  const policy = await loadOptimizerPolicy(admin, s.workspace_id);
  // Default gate uses the reversible class — the worker re-gates on the ACTUAL proposed
  // lever class (offers/structural are always approval-gated).
  const gate = evaluateProposalGate(policy, { productId: s.product_id, leverClass: "reversible" });

  const next = await nextLeverToTest({
    workspaceId: s.workspace_id,
    productId: s.product_id,
    landerType: s.lander_type,
    audience: s.audience,
    now: opts.now,
    admin,
  });

  const [chapterPriors, ltv, calib, landerSummary] = await Promise.all([
    computeChapterPriorsFromFunnel({ workspaceId: s.workspace_id, admin }).catch(() => ({}) as Record<string, number>),
    loadLatestLtv(admin, s),
    getCalibrationState(s.workspace_id).catch(() => ({ calibrated: false, weights_version: 0, sub_ltv_factor: 1 })),
    loadCurrentLanderSummary(admin, s.product_id),
  ]);
  const conservative = !calib.calibrated;

  const topCandidates = next.candidates.slice(0, 8);
  const chapterSignal = Object.entries(chapterPriors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([c, v]) => `${c}=${v}`)
    .join(", ");

  const text = [
    `STOREFRONT OPTIMIZER CAMPAIGN BRIEF — surface ${surfaceKey(s)}`,
    `  product=${s.product_id} · lander_type=${s.lander_type} · audience=${s.audience}`,
    ``,
    `ACTIVATION GATE: ${gate.disposition} — ${gate.reason}`,
    `  policy: active=${policy?.active ?? false} · auto_run_reversible=${policy?.auto_run_reversible ?? false} · holdout_pct=${policy?.holdout_pct ?? 0.1} · min_sample=${policy?.min_sample ?? "—"}`,
    `  CALIBRATION: ${conservative ? "UNCALIBRATED → run CONSERVATIVE (smaller exposed bet, tighter thresholds; M1 already enforces conservative bandit thresholds)" : "calibrated → normal bet size"}`,
    ``,
    `NEXT-BEST LEVER (M2 nextLeverToTest): ${next.choice ? `${next.choice.lever_key} (chapter=${next.choice.chapter}, importance=${next.choice.importance}, prior=${next.choice.prior}, n_tests=${next.choice.n_tests}, age_days=${next.choice.age_days}, reason=${next.choice.reason})` : "(none — taxonomy empty)"}`,
    `  RANKED component-level candidates (lever_key · importance · n_tests · reason):`,
    ...topCandidates.map((c) => `    - ${c.lever_key} · imp=${c.importance} · n=${c.n_tests} · ${c.reason} (score=${c.score})`),
    ``,
    `FUNNEL SIGNAL (chapter dwell+CTA share, normalized): ${chapterSignal || "(no funnel events yet)"}`,
    ``,
    `PREDICTED-LTV-PER-VISITOR (M3, the reward): ${
      ltv
        ? `${ltv.predicted_ltv_per_visitor_cents}¢/visitor · sub_attach=${ltv.sub_attach_rate} · visitors=${ltv.visitors} · snapshot=${ltv.snapshot_date} · calibrated=${ltv.calibrated}`
        : "(no snapshot yet)"
    }`,
    ``,
    `LIVE LANDER CONTENT (patch targets):`,
    landerSummary,
  ].join("\n");

  return { surface: s, text, policy, gate, candidates: next.candidates, conservative };
}

// ── Hero generation (worker-side; the box session never calls the image API) ────

/**
 * Generate + persist a Nano-Banana hero for a campaign variant and return its public,
 * re-signable URL (null on failure). Mirrors [[advertorial-pages]] `ensureReasonsHero`:
 * composites the product's isolated pouch image, compresses to webp, uploads to the
 * product-media bucket. The worker calls this for a kind='hero' variant, then stores the
 * URL into the variant's `heroImageUrl` patch.
 */
export async function generateCampaignHero(opts: {
  workspaceId: string;
  productId: string;
  prompt: string;
  slug: string;
  admin?: Admin;
}): Promise<string | null> {
  const admin = opts.admin ?? createAdminClient();
  const [{ data: product }, { data: variant }] = await Promise.all([
    admin.from("products").select("handle, title").eq("id", opts.productId).maybeSingle(),
    admin
      .from("product_variants")
      .select("isolated_image_url")
      .eq("product_id", opts.productId)
      .not("isolated_image_url", "is", null)
      .limit(1)
      .maybeSingle(),
  ]);
  const handle = product?.handle as string | undefined;
  const isolated = variant?.isolated_image_url as string | undefined;
  if (!handle || !isolated) return null;
  const safeSlug = opts.slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 60) || "hero";
  const path = `workspaces/${opts.workspaceId}/landers/${handle}/optimizer/${safeSlug}.webp`;
  try {
    const { buffer: raw } = await generateNanoBananaProCombine({
      workspaceId: opts.workspaceId,
      prompt: opts.prompt,
      imageUrls: [isolated],
      aspectRatio: "16:9",
    });
    const { buffer } = await compressToWebp(raw, { maxWidth: 1600, quality: 82 });
    const { error } = await admin.storage
      .from(OPTIMIZER_HERO_BUCKET)
      .upload(path, buffer, { contentType: "image/webp", upsert: true });
    if (error) return null;
    return admin.storage.from(OPTIMIZER_HERO_BUCKET).getPublicUrl(path).data.publicUrl;
  } catch (e) {
    console.warn(`[storefront-optimizer] hero generation failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ── Materialize (the worker's WRITE — stand up the M1 campaign) ─────────────────

export interface MaterializeResult {
  ok: boolean;
  experiment_id?: string;
  lever_key?: string;
  detail: string;
}

/**
 * Stand up the M1 experiment from the agent's typed proposal: create the
 * `storefront_experiments` row (status='running', carrying the HYPOTHESIS — the campaign
 * record M5 grades) + a control arm vs the variant arm, then it serves traffic and the
 * M1 refresh ([[storefront-experiment-refresh]]) drives attribution → decision →
 * promote/kill/rollback → commit-to-M2, all already wired. ONE atomic lever per campaign.
 *
 * Idempotent at the surface grain: refuses to stand up a second campaign while one is
 * active (≤1 per surface). Conservative mode (M3 uncalibrated) reserves a bigger holdout.
 * For a kind='hero' variant the worker passes a pre-generated `heroImageUrl` in the patch.
 */
export async function materializeCampaign(opts: {
  workspaceId: string;
  proposal: OptimizerProposal;
  productId: string;
  conservative: boolean;
  createdBy?: string | null;
  patchOverride?: VariantPatch;
  now?: Date;
  admin?: Admin;
}): Promise<MaterializeResult> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  const p = opts.proposal;
  const surface: OptimizerSurface = {
    workspace_id: opts.workspaceId,
    product_id: opts.productId,
    lander_type: p.lander_type,
    audience: p.audience,
  };

  // ≤1 active campaign per surface — clean attribution, never bundle.
  if (await hasActiveCampaignForSurface(admin, surface)) {
    return { ok: false, detail: `a campaign is already active on ${surfaceKey(surface)} — not standing up a second` };
  }

  const patch = opts.patchOverride ?? p.variant.patch ?? {};
  if (!patch || Object.keys(patch).length === 0) {
    return { ok: false, detail: "variant patch is empty — nothing to test" };
  }

  // Holdout: the proposal's ask, clamped to the policy floor; conservative reserves more.
  let holdout = typeof p.holdout_pct === "number" ? p.holdout_pct : 0.1;
  holdout = Math.min(0.9, Math.max(0.05, holdout));
  if (opts.conservative) holdout = Math.max(holdout, CONSERVATIVE_MIN_HOLDOUT);

  // Create the experiment (the campaign record).
  const { data: expRow, error: expErr } = await admin
    .from("storefront_experiments")
    .insert({
      workspace_id: opts.workspaceId,
      product_id: opts.productId,
      lander_type: p.lander_type,
      audience: p.audience,
      lever: p.lever_key,
      hypothesis: p.hypothesis,
      status: "running",
      holdout_pct: holdout,
      created_by: opts.createdBy ?? null,
      started_at: now.toISOString(),
      last_decision: {
        action: "stood_up",
        by: "storefront-optimizer",
        lever_class: p.lever_class,
        reasoning: p.reasoning,
        conservative: opts.conservative,
        at: now.toISOString(),
      },
    })
    .select("id")
    .single();
  if (expErr || !expRow) {
    return { ok: false, detail: `experiment insert failed: ${expErr?.message ?? "no row"}` };
  }
  const experimentId = expRow.id as string;

  // Control (holdout/baseline — empty patch) + the variant arm.
  const { error: varErr } = await admin.from("storefront_experiment_variants").insert([
    {
      experiment_id: experimentId,
      workspace_id: opts.workspaceId,
      label: "control",
      is_control: true,
      patch: {},
    },
    {
      experiment_id: experimentId,
      workspace_id: opts.workspaceId,
      label: p.variant.label || "variant",
      is_control: false,
      patch,
    },
  ]);
  if (varErr) {
    // Roll back the orphaned experiment so the surface isn't left half-stood-up.
    await admin.from("storefront_experiments").delete().eq("id", experimentId);
    return { ok: false, detail: `variant insert failed (experiment rolled back): ${varErr.message}` };
  }

  return {
    ok: true,
    experiment_id: experimentId,
    lever_key: p.lever_key,
    detail: `stood up experiment ${experimentId} on ${surfaceKey(surface)} — lever ${p.lever_key}, holdout ${holdout}${opts.conservative ? " (conservative)" : ""}`,
  };
}

// ── Offer lever (M6 — persist-to-renewal, ALWAYS owner-approved) ─────────────────

/** The typed offer the box session proposes (lever_class='offer'). Created `proposed` +
 *  inactive, margin-checked, surfaced for owner approval — NEVER auto-activated. */
export interface OptimizerOfferPlan {
  offer_type: OfferType;
  /** Set when offer_type='subscribe_discount_pct' — the override S&S percent at renewal. */
  subscribe_discount_pct?: number;
  /** Set when offer_type='fixed_renewal_price' — the fixed per-unit renewal price (cents). */
  renewal_price_cents?: number;
  /** Optional explicit window; defaults to now → +60d (a time-boxed run). */
  starts_at?: string;
  ends_at?: string;
  /** Honest-labeling content patch shown on the offer ARM (compliance invariant). */
  display_patch?: VariantPatch;
  label?: string;
}

export interface ProposeOptimizerOfferResult {
  ok: boolean;
  blocked: boolean;
  offer_id?: string;
  detail: string;
  margin_pct?: number | null;
  floor_pct?: number;
}

/**
 * Propose a persist-to-renewal offer (the M6 lever): create a `proposed`/inactive
 * [[renewal-offers]] row after the margin-floor check. Returns { blocked:true } when the
 * modeled renewal margin is below the policy floor — the worker escalates to Growth + CFO
 * instead of surfacing it as a normal approvable proposal. NEVER activates (owner-gated).
 */
export async function proposeOptimizerOffer(opts: {
  workspaceId: string;
  surface: OptimizerSurface;
  offer: OptimizerOfferPlan;
  hypothesis: string;
  reasoning: string;
  policy: OptimizerPolicy | null;
  createdBy?: string | null;
  now?: Date;
  admin?: Admin;
}): Promise<ProposeOptimizerOfferResult> {
  const admin = opts.admin ?? createAdminClient();
  const s = opts.surface;
  const floorPct =
    typeof opts.policy?.renewal_margin_floor_pct === "number"
      ? opts.policy.renewal_margin_floor_pct
      : DEFAULT_RENEWAL_MARGIN_FLOOR_PCT;

  const plan: OfferPlan = {
    product_id: s.product_id,
    lander_type: s.lander_type,
    audience: s.audience,
    offer_type: opts.offer.offer_type,
    subscribe_discount_pct: opts.offer.subscribe_discount_pct,
    renewal_price_cents: opts.offer.renewal_price_cents,
    starts_at: opts.offer.starts_at,
    ends_at: opts.offer.ends_at,
    hypothesis: opts.hypothesis,
    rationale: opts.reasoning,
  };
  const r = await proposeOffer({ workspaceId: opts.workspaceId, plan, floorPct, createdBy: opts.createdBy, now: opts.now, admin });
  return { ok: r.ok, blocked: r.blocked, offer_id: r.offer_id, detail: r.detail, margin_pct: r.margin?.model.modeled_margin_pct ?? null, floor_pct: floorPct };
}

/**
 * On owner approval, run the approved offer as an M1 arm vs holdout: stand up the
 * `storefront_experiments` row (lever=renewal_offer, lever_class offer, the campaign record
 * M5 grades) + a control arm vs the offer arm (carrying the honest-labeling display patch),
 * LINK the offer to the experiment/arm, then ACTIVATE it (persists to renewal). ≤1 active
 * campaign per surface. Subscribers who convert on the offer arm get bound at checkout.
 */
export async function materializeOfferCampaign(opts: {
  workspaceId: string;
  surface: OptimizerSurface;
  offerId: string;
  leverKey: string;
  hypothesis: string;
  reasoning: string;
  displayPatch?: VariantPatch;
  label?: string;
  holdoutPct?: number;
  conservative: boolean;
  createdBy?: string | null;
  now?: Date;
  admin?: Admin;
}): Promise<MaterializeResult & { variant_id?: string }> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  const s = opts.surface;

  if (await hasActiveCampaignForSurface(admin, s)) {
    return { ok: false, detail: `a campaign is already active on ${surfaceKey(s)} — not standing up a second` };
  }

  let holdout = typeof opts.holdoutPct === "number" ? opts.holdoutPct : 0.1;
  holdout = Math.min(0.9, Math.max(0.05, holdout));
  if (opts.conservative) holdout = Math.max(holdout, CONSERVATIVE_MIN_HOLDOUT);

  const { data: expRow, error: expErr } = await admin
    .from("storefront_experiments")
    .insert({
      workspace_id: opts.workspaceId,
      product_id: s.product_id,
      lander_type: s.lander_type,
      audience: s.audience,
      lever: opts.leverKey,
      hypothesis: opts.hypothesis,
      status: "running",
      holdout_pct: holdout,
      created_by: opts.createdBy ?? null,
      started_at: now.toISOString(),
      last_decision: {
        action: "stood_up",
        by: "storefront-optimizer",
        lever_class: "offer",
        offer_id: opts.offerId,
        reasoning: opts.reasoning,
        conservative: opts.conservative,
        at: now.toISOString(),
      },
    })
    .select("id")
    .single();
  if (expErr || !expRow) return { ok: false, detail: `offer experiment insert failed: ${expErr?.message ?? "no row"}` };
  const experimentId = expRow.id as string;

  // Control (empty patch) + the offer arm (honest-labeling display patch, may be empty).
  const { data: variants, error: varErr } = await admin
    .from("storefront_experiment_variants")
    .insert([
      { experiment_id: experimentId, workspace_id: opts.workspaceId, label: "control", is_control: true, patch: {} },
      { experiment_id: experimentId, workspace_id: opts.workspaceId, label: opts.label || "offer", is_control: false, patch: opts.displayPatch ?? {} },
    ])
    .select("id, is_control");
  if (varErr || !variants) {
    await admin.from("storefront_experiments").delete().eq("id", experimentId);
    return { ok: false, detail: `offer variant insert failed (experiment rolled back): ${varErr?.message ?? "no rows"}` };
  }
  const offerArm = (variants as Array<{ id: string; is_control: boolean }>).find((v) => !v.is_control);
  if (!offerArm) {
    await admin.from("storefront_experiments").delete().eq("id", experimentId);
    return { ok: false, detail: "offer arm not found after insert (experiment rolled back)" };
  }

  // Link the offer to the experiment + arm so checkout can bind offer-arm converters.
  await admin
    .from("pricing_rule_offers")
    .update({ experiment_id: experimentId, variant_id: offerArm.id, updated_at: now.toISOString() })
    .eq("id", opts.offerId)
    .eq("workspace_id", opts.workspaceId);

  // Activate the offer (persists to renewal). Refuses a below-floor offer (defense in depth).
  const act = await activateOffer({ workspaceId: opts.workspaceId, offerId: opts.offerId, approvedBy: opts.createdBy, now, admin });
  if (!act.ok) {
    await admin.from("storefront_experiments").delete().eq("id", experimentId);
    return { ok: false, detail: `offer activation failed (experiment rolled back): ${act.detail}` };
  }

  return {
    ok: true,
    experiment_id: experimentId,
    variant_id: offerArm.id,
    lever_key: opts.leverKey,
    detail: `stood up OFFER experiment ${experimentId} on ${surfaceKey(s)} — offer ${opts.offerId} active, holdout ${holdout}${opts.conservative ? " (conservative)" : ""}`,
  };
}
