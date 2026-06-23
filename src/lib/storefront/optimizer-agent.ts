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
import { generateNanoBananaProCombine, type NanoBananaAspect } from "@/lib/gemini";
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
import { loadLeverGradeSignal, type LeverGradeSignal } from "@/lib/storefront/campaign-grader";
import type { VariantPatch } from "@/lib/storefront/experiments";

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

// ── Hero dimensions / aspect (optimizer-hero-preview-gate § grounding) ──────────
// Generate at the REAL hero slot, not a guessed size: for the PDP, the variant's stored
// hero_width × hero_height (what HeroSection renders — sourced from the product's `slot='hero'`
// product_media row); for the other landers, the hero aspect of that section. Pick the closest
// Nano-Banana aspectRatio so the result fits the slot with no distortion / awkward crop.
const NANO_ASPECTS: NanoBananaAspect[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
function aspectRatioOf(a: NanoBananaAspect): number {
  const [w, h] = a.split(":").map(Number);
  return w / h;
}
/** Closest Nano-Banana aspectRatio to a raw width×height (log-distance — matches how the eye
 *  reads "off" crops). Defaults to a square-ish 4:5 when dimensions are missing. */
export function nearestNanoAspect(width?: number | null, height?: number | null): NanoBananaAspect {
  if (!width || !height || width <= 0 || height <= 0) return "4:5";
  const target = Math.log(width / height);
  let best: NanoBananaAspect = NANO_ASPECTS[0];
  let bestD = Infinity;
  for (const a of NANO_ASPECTS) {
    const d = Math.abs(Math.log(aspectRatioOf(a)) - target);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}
/** The hero aspect each non-PDP lander section renders (see the storefront _sections):
 *  advertorial 16:10 product/lifestyle hero · before/after 3:4 · listicle portrait. PDP is
 *  resolved from the real uploaded hero dimensions, so it's not in this map. */
const LANDER_HERO_ASPECT: Record<string, NanoBananaAspect> = {
  advertorial: "3:2", // AdvertorialHero non-avatar = 16:10 → nearest Nano 3:2
  beforeafter: "3:4", // BeforeAfterHero aspectRatio 3/4
  listicle: "4:5", // ReasonsListicle portrait hero
};

/**
 * Resolve the Nano-Banana aspectRatio the generated hero should target for a surface so it
 * fits the lander's actual hero slot. PDP reads the product's stored hero dimensions (the
 * `slot='hero'` product_media row HeroSection renders); the other landers use their section's
 * fixed aspect. Best-effort — falls back to the lander map / 4:5 if dimensions are missing.
 */
export async function resolveHeroAspect(opts: {
  admin: Admin;
  productId: string;
  landerType: string;
}): Promise<NanoBananaAspect> {
  if (opts.landerType === "pdp") {
    try {
      const { data } = await opts.admin
        .from("product_media")
        .select("width, height")
        .eq("product_id", opts.productId)
        .eq("slot", "hero")
        .order("display_order")
        .limit(1)
        .maybeSingle();
      const w = (data as { width?: number | null } | null)?.width ?? null;
      const h = (data as { height?: number | null } | null)?.height ?? null;
      if (w && h) return nearestNanoAspect(w, h);
    } catch {
      // fall through to the default below
    }
    return "4:5"; // HeroSection's own legacy fallback is ~square; 4:5 is the safe slot fit
  }
  return LANDER_HERO_ASPECT[opts.landerType] ?? "4:5";
}

/** Grounding preamble prepended to every optimizer hero prompt: composite the REAL isolated
 *  pouch faithfully, never redraw the packaging (optimizer-hero-preview-gate § grounding). */
const HERO_GROUNDING_PREAMBLE =
  "Composite the EXACT product shown in the attached product image into the scene. " +
  "The attached image is the real, isolated product pouch — reproduce its packaging, label text, " +
  "colors and proportions faithfully. NEVER redraw, restyle, or hallucinate the packaging or label. " +
  "Place it naturally and in sharp focus as the hero of the composition.";

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
  /** The M5 campaign-grade training signal for this surface (per-lever avg grades + trend). */
  gradeSignal: LeverGradeSignal;
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

  // M5 training signal — per-lever campaign-grade history for this surface. Feeds the lever
  // selector as a secondary weight (favor high-graded patterns) AND is surfaced in the brief so
  // the box session biases its hypothesis toward sound, high-graded bets.
  const gradeSignal = await loadLeverGradeSignal({
    workspaceId: s.workspace_id,
    productId: s.product_id,
    landerType: s.lander_type,
    audience: s.audience,
    admin,
  });

  const next = await nextLeverToTest({
    workspaceId: s.workspace_id,
    productId: s.product_id,
    landerType: s.lander_type,
    audience: s.audience,
    gradeBias: gradeSignal.avgByLever,
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
    `CAMPAIGN GRADE HISTORY (M5 Head-of-Growth training signal — bias toward high-graded HYPOTHESIS patterns, not lucky wins): ${
      gradeSignal.graded > 0
        ? `agent avg grade=${gradeSignal.overallAvg}/10 over ${gradeSignal.graded} graded campaign(s)`
        : "(no graded campaigns yet)"
    }`,
    ...(gradeSignal.graded > 0
      ? Object.entries(gradeSignal.avgByLever)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([lever, avg]) => `    - ${lever}: avg grade=${avg}/10 · avg hypothesis-quality=${gradeSignal.avgHypothesisByLever[lever] ?? "—"}/10 · n=${gradeSignal.countByLever[lever] ?? 0}`)
      : []),
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

  return { surface: s, text, policy, gate, candidates: next.candidates, conservative, gradeSignal };
}

// ── Hero generation (worker-side; the box session never calls the image API) ────

/**
 * Generate + persist a Nano-Banana hero for a campaign variant and return its public,
 * re-signable URL (null on failure). Mirrors [[advertorial-pages]] `ensureReasonsHero`:
 * composites the product's isolated pouch image, compresses to webp, uploads to the
 * product-media bucket. The worker calls this for a kind='hero' variant, then stores the
 * URL into the variant's `heroImageUrl` patch.
 *
 * Grounding (optimizer-hero-preview-gate § grounding):
 *  - Composites the REAL pouch from `product_variants.isolated_image_url` — passed as the
 *    Nano-Banana Pro *combine* reference image, with a preamble that forbids redrawing the
 *    packaging, so the label is the exact product (never hallucinated).
 *  - Targets the lander's actual hero slot: `landerType` resolves the closest Nano aspectRatio
 *    (PDP = the variant's stored hero_width×hero_height; other landers = their section aspect),
 *    so the result fits the slot with no distortion / awkward crop.
 *  - `notes` (owner reject-with-notes) augment the prompt so the regeneration honors the asks.
 */
export async function generateCampaignHero(opts: {
  workspaceId: string;
  productId: string;
  prompt: string;
  slug: string;
  landerType?: string;
  /** Owner revision notes accumulated across the preview/reject loop (oldest → newest). */
  notes?: string[];
  /** Override the resolved aspect (else derived from landerType + the real hero slot). */
  aspectRatio?: NanoBananaAspect;
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

  const aspectRatio =
    opts.aspectRatio ??
    (await resolveHeroAspect({ admin, productId: opts.productId, landerType: opts.landerType ?? "pdp" }));

  // Augment the prompt: grounding preamble + the hypothesis prompt + any owner revision notes
  // (the reject-with-notes loop learns within the gate — nothing serves until the owner approves).
  const notes = (opts.notes ?? []).map((n) => n.trim()).filter(Boolean);
  const prompt = [
    HERO_GROUNDING_PREAMBLE,
    "",
    opts.prompt,
    ...(notes.length
      ? ["", "Owner revision notes — apply ALL of these to this regeneration:", ...notes.map((n) => `- ${n}`)]
      : []),
  ].join("\n");

  try {
    const { buffer: raw } = await generateNanoBananaProCombine({
      workspaceId: opts.workspaceId,
      prompt,
      imageUrls: [isolated],
      aspectRatio,
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
