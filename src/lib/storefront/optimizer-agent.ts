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
import { errText } from "@/lib/error-text";
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
  LANDER_TO_DESTINATION,
  DIAGNOSTICS_WINDOW_DAYS,
  type LeverCandidate,
  type LanderType,
} from "@/lib/storefront/lever-memory";
import { computeBottlenecks, type BottleneckVerdict } from "@/lib/storefront/funnel-tree";
import { getCalibrationState } from "@/lib/storefront/calibration";
import { loadLeverGradeSignal, type LeverGradeSignal } from "@/lib/storefront/campaign-grader";
import type { VariantPatch } from "@/lib/storefront/experiments";
import { republishExperimentManifest } from "@/lib/storefront/experiment-cache";
import { recordDirectorActivity } from "@/lib/director-activity";
import { inngest } from "@/lib/inngest/client";

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

/** The variant the box session proposes — a reversible content patch, a hero the
 *  worker generates from a prompt (the box never calls the image API itself), or a
 *  persist-to-renewal pricing OFFER (storefront-renewal-offer-lever). The offer kind
 *  is always approval-gated and materializes as a pricing_rule_offers row scoped to
 *  the experiment arm. */
export interface OptimizerVariantPlan {
  label: string;
  kind: "content" | "hero" | "offer";
  /** Reversible content patch (copy / chapter add-remove-reorder). Used when kind='content'. */
  patch?: VariantPatch;
  /** Nano-Banana hero prompt. Used when kind='hero' — the WORKER generates + uploads it. */
  hero_prompt?: string;
  /** Persist-to-renewal offer terms. Used when kind='offer' (storefront-renewal-offer-lever).
   *  The variant arm carries the offer; the control arm gets base pricing. */
  offer?: OfferPlan;
}

/** The persist-to-renewal offer the agent proposes (storefront-renewal-offer-lever P1).
 *  Mirrors the pricing_rule_offers shape (the live schema is the spec) but as a typed
 *  plan the agent emits; the worker writes the actual row + applies the margin-floor + window
 *  guardrails. Offer is ALWAYS owner-approved before it activates (bleeds margin on every renewal). */
export interface OfferPlan {
  /** Discriminator: which delta this offer carries. */
  offer_type: "subscribe_discount_pct" | "fixed_renewal_price";
  /** When offer_type='subscribe_discount_pct': the override % (0–100). */
  subscribe_discount_pct?: number;
  /** When offer_type='fixed_renewal_price': the pinned per-unit cents. */
  renewal_price_cents?: number;
  /** End of the offer window (ISO timestamp). starts_at defaults to now() in the DB. Every offer is
   *  explicitly time-boxed — auto-expire at ends_at is the Phase 2 safety net. */
  ends_at: string;
  /** Optional rationale the agent supplies on the row (audit trail for the approval card). */
  rationale?: string;
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

/** Spec growth-adopt-storefront-optimizer Phase 3 — mirror of the experiment-refresh gate
 *  ([[storefront-experiment-refresh]]) on the materialization side. Surfaces a previously-
 *  failed-to-deliver experiment on the SAME surface (any status, latest first) so the
 *  worker refuses to stand up a new campaign that would silently promote the same
 *  (untrusted-delivery) variant configuration without re-verification. Returns the
 *  blocking experiment id if one exists, else null. Best-effort (degrades to null). */
export async function findUndeliveredExperimentForSurface(
  admin: Admin,
  s: OptimizerSurface,
): Promise<string | null> {
  try {
    const { data } = await admin
      .from("storefront_experiments")
      .select("id, created_at")
      .eq("workspace_id", s.workspace_id)
      .eq("product_id", s.product_id)
      .eq("lander_type", s.lander_type)
      .eq("audience", s.audience)
      .eq("last_decision->>delivery_flag", "failed_to_deliver")
      .order("created_at", { ascending: false })
      .limit(1);
    return data && data.length ? (data[0].id as string) : null;
  } catch {
    return null;
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

/** Outcome-anchored WHY signal for the surface — the [[funnel-tree]] `computeBottlenecks`
 *  verdict for this surface's (product × lander_type→destination), same window the
 *  chapter priors are seeded from. Read-only, degrades to `null` on any failure so
 *  the brief is still useful when the events pipeline is empty / mid-migration. */
async function loadSurfaceBottleneck(admin: Admin, s: OptimizerSurface): Promise<BottleneckVerdict | null> {
  try {
    const { data: prodRow } = await admin
      .from("products")
      .select("handle")
      .eq("id", s.product_id)
      .maybeSingle();
    const productHandle = (prodRow as { handle: string | null } | null)?.handle?.toLowerCase() ?? null;
    if (!productHandle) return null;
    const now = new Date();
    const endIso = now.toISOString();
    const startIso = new Date(now.getTime() - DIAGNOSTICS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result = await computeBottlenecks({
      admin, workspaceId: s.workspace_id, startIso, endIso, productHandle,
    });
    const dest = LANDER_TO_DESTINATION[s.lander_type];
    return result.destinations.find((v) => v.key === dest) ?? null;
  } catch {
    return null;
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

  const [chapterPriors, bottleneck, ltv, calib, landerSummary] = await Promise.all([
    computeChapterPriorsFromFunnel({ workspaceId: s.workspace_id, admin }).catch(() => ({}) as Record<string, number>),
    loadSurfaceBottleneck(admin, s),
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
    `BOTTLENECK / WHY (outcome-anchored — WHERE the funnel actually breaks for this surface): ${
      bottleneck
        ? `verdict=${bottleneck.bottleneck} · confidence=${bottleneck.confidence}`
        : "(no verdict — surface below the SDK's traffic floor / product handle unresolved)"
    }`,
    ...(bottleneck
      ? [
          `  visits=${bottleneck.visits} · reached_pricing=${bottleneck.reached_pricing}`,
          `  carry-to-pricing=${bottleneck.carry_to_pricing_pct}% (gap-to-best=${bottleneck.carry_gap_pct}pp) · close=${bottleneck.close_pct}% (gap-to-best=${bottleneck.close_gap_pct}pp)`,
          `  reading: ${bottleneck.recommendation}`,
        ]
      : []),
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
    console.warn(`[storefront-optimizer] hero generation failed: ${errText(e)}`);
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
 * `storefront_experiments` row (status='running' by default, carrying the HYPOTHESIS — the
 * campaign record M5 grades) + a control arm vs the variant arm, then it serves traffic and
 * the M1 refresh ([[storefront-experiment-refresh]]) drives attribution → decision →
 * promote/kill/rollback → commit-to-M2, all already wired. ONE atomic lever per campaign.
 *
 * Pass `initialStatus: 'draft'` (used by Phase 3 of [[../specs/growth-winning-creative-amplifier]]
 * via `materializeOptimizerCampaign` + `pairAmplifiedWinnerWithLander`) to stand up the
 * experiment at status='draft' with NO `started_at` — the owner approves it before any
 * traffic is served. Calls then flip the row to 'running' via the experiment-detail approval
 * action (same shape as the existing offer 'proposed' → 'active' flip).
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
  /** Initial status of the new experiment row. Defaults to 'running' (serve immediately).
   *  Phase 3 of [[../specs/growth-winning-creative-amplifier]] passes 'draft' so the
   *  matched-lander experiment from an amplified winner is owner-approved before serving. */
  initialStatus?: "draft" | "running";
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

  // Spec growth-adopt-storefront-optimizer Phase 3 — mirror of the experiment-refresh
  // delivery gate: refuse to stand up a NEW campaign on a surface whose latest prior
  // experiment carries `last_decision.delivery_flag='failed_to_deliver'`. The previous
  // campaign's variant configuration never actually reached shoppers; standing up a new
  // one would re-bury the failure under a fresh hypothesis. Logs one
  // `blocked_promote_undelivered` director_activity row so the refusal surfaces to the
  // Growth director, then refuses.
  const blockingExperimentId = await findUndeliveredExperimentForSurface(admin, surface);
  if (blockingExperimentId) {
    await recordDirectorActivity(admin, {
      workspaceId: opts.workspaceId,
      directorFunction: "growth",
      actionKind: "blocked_promote_undelivered",
      specSlug: null,
      reason: `materializeCampaign refused on ${surfaceKey(surface)} — prior experiment ${blockingExperimentId} carries delivery_flag='failed_to_deliver'; re-verify delivery before standing up a new campaign`,
      metadata: {
        experiment_id: blockingExperimentId,
        lander_type: p.lander_type,
        audience: p.audience,
        product_id: opts.productId,
        lever: p.lever_key,
        source: "materializeCampaign",
      },
    });
    return {
      ok: false,
      detail: `prior experiment ${blockingExperimentId} on ${surfaceKey(surface)} carries delivery_flag='failed_to_deliver' — re-verify delivery before standing up a new campaign`,
    };
  }

  const patch = opts.patchOverride ?? p.variant.patch ?? {};
  if (!patch || Object.keys(patch).length === 0) {
    return { ok: false, detail: "variant patch is empty — nothing to test" };
  }

  // Holdout: the proposal's ask, clamped to the policy floor; conservative reserves more.
  let holdout = typeof p.holdout_pct === "number" ? p.holdout_pct : 0.1;
  holdout = Math.min(0.9, Math.max(0.05, holdout));
  if (opts.conservative) holdout = Math.max(holdout, CONSERVATIVE_MIN_HOLDOUT);

  // Create the experiment (the campaign record). `initialStatus='draft'` (Phase 3
  // matched-lander pairing) defers `started_at` until the owner approves the row.
  const initialStatus = opts.initialStatus ?? "running";
  const expInsert: Record<string, unknown> = {
    workspace_id: opts.workspaceId,
    product_id: opts.productId,
    lander_type: p.lander_type,
    audience: p.audience,
    lever: p.lever_key,
    hypothesis: p.hypothesis,
    status: initialStatus,
    holdout_pct: holdout,
    created_by: opts.createdBy ?? null,
    last_decision: {
      action: initialStatus === "draft" ? "proposed" : "stood_up",
      by: "storefront-optimizer",
      lever_class: p.lever_class,
      reasoning: p.reasoning,
      conservative: opts.conservative,
      at: now.toISOString(),
    },
  };
  if (initialStatus === "running") expInsert.started_at = now.toISOString();
  const { data: expRow, error: expErr } = await admin
    .from("storefront_experiments")
    .insert(expInsert)
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

  // Re-publish the active-experiment manifest to the edge + purge the PDP render so
  // the new arm serves immediately (pdp-edge-served-experiments). PDP only — the
  // other lander types render server-side, not via the edge manifest. Only publishes
  // for status='running' — a draft has no arm to serve.
  if (p.lander_type === "pdp" && initialStatus === "running") {
    await republishExperimentManifest(admin, [opts.productId]);
  }

  return {
    ok: true,
    experiment_id: experimentId,
    lever_key: p.lever_key,
    detail: `stood up experiment ${experimentId} on ${surfaceKey(surface)} — lever ${p.lever_key}, holdout ${holdout}${opts.conservative ? " (conservative)" : ""}${initialStatus === "draft" ? " (status=draft, awaiting owner approval)" : ""}`,
  };
}

/**
 * Alias for [[materializeCampaign]] — the optimizer's WRITE entry as referenced by
 * Phase 3 of [[../specs/growth-winning-creative-amplifier]]: an amplified winner whose
 * archetype is advertorial-family opens a matched-lander hypothesis via this entry at
 * `status='draft'` with the winner's hook/mechanism as the variant patch. Same surface
 * dedup + margin guard as the optimizer's own stand-up path — Phase 3 just calls in
 * from the ads side.
 */
export const materializeOptimizerCampaign = materializeCampaign;

// ────────────────────────────────────────────────────────────────────────────────
// Phase 3 reverse direction (growth-winning-creative-amplifier) — promoted lander
// variant ⇒ fresh static ad for the matching angle.
// ────────────────────────────────────────────────────────────────────────────────

/** The `director_activity.action_kind` stamped on each Phase 3 cross-side pairing — both
 *  the forward direction (amplified winner → matched-lander experiment in `pairAmplifiedWinnerWithLander`)
 *  and the reverse direction (promoted lander variant → fresh static via
 *  `pairPromotedLanderWithAd` below). One stable kind so the brain audit + Growth
 *  director's recap can trace the perf↔creative loop end-to-end. */
export const PAIRED_WINNER_LANDER_ACTION_KIND = "paired_winner_lander" as const;

/** Map a storefront lander_type to the killer-statics archetype the maker pipeline accepts.
 *  Used by the reverse direction (promoted lander → fresh static) so the new static lands on
 *  an archetype that mirrors the winning lander's shape. */
export function archetypeForPromotedLanderType(landerType: LanderType): string {
  if (landerType === "advertorial") return "advertorial";
  if (landerType === "beforeafter") return "before_after";
  if (landerType === "listicle") return "testimonial";
  return "testimonial";
}

/** Test seam for `pairPromotedLanderWithAd` — the live path sends Inngest events + writes
 *  director_activity rows via the real modules; tests pass spies. */
export interface PairPromotedLanderDeps {
  sendInngest?: (event: { name: string; data: unknown }) => Promise<unknown>;
  recordActivity?: (
    admin: Admin,
    row: Parameters<typeof recordDirectorActivity>[1],
  ) => Promise<unknown>;
}

const defaultPairPromotedDeps: Required<PairPromotedLanderDeps> = {
  sendInngest: (event) => inngest.send(event) as Promise<unknown>,
  recordActivity: (admin, row) => recordDirectorActivity(admin, row),
};

export interface PairPromotedLanderResult {
  ok: boolean;
  reason?: string;
  /** The fresh `ad_campaigns.id` inserted at status='ready' (when ok=true). */
  ad_campaign_id?: string;
  /** The `product_ad_angles.id` resolved as the lander's matching angle. */
  angle_id?: string;
  /** The static archetype the `ad-tool/static-requested` event was fired with. */
  archetype?: string;
}

/**
 * Reverse direction of [[../specs/growth-winning-creative-amplifier]] Phase 3 — when the
 * storefront optimizer (via the experiment-refresh promote path) marks a lander variant
 * as the winner on an advertorial-family surface, request a FRESH static ad for that
 * lander's matching angle so the ad side gets a creative refresh that mirrors the lander
 * shape.
 *
 * Process:
 *   1. Resolve the matching angle — the most-recent active [[../tables/product_ad_angles]]
 *      row for (workspace, product). The lander variant doesn't carry an angle FK, so the
 *      most-recent active angle is the best deterministic anchor.
 *   2. Insert a fresh `ad_campaigns` row at `status='ready'` tagged to that angle (mirrors
 *      the voice-angle-approve + amplifier insert shape so the ready-to-test queue picks
 *      it up once the maker render completes).
 *   3. Fire `ad-tool/static-requested` for the new campaign with the archetype derived
 *      from the lander_type ([[archetypeForPromotedLanderType]]).
 *   4. Stamp ONE [[../tables/director_activity]] row of action_kind
 *      [[PAIRED_WINNER_LANDER_ACTION_KIND]] so the perf↔creative loop is traceable.
 *
 * Best-effort: a missing angle / failed insert resolves to {ok:false, reason} so the
 * outer refresh tick continues unaffected. Skips entirely for non-advertorial-family
 * lander types (`pdp` — the ad side doesn't ship statics tied to bare-PDP variants).
 */
export async function pairPromotedLanderWithAd(
  admin: Admin,
  opts: {
    workspaceId: string;
    productId: string;
    landerType: LanderType;
    experimentId: string;
    variantId: string;
    specSlug?: string | null;
    deps?: PairPromotedLanderDeps;
  },
): Promise<PairPromotedLanderResult> {
  const deps = { ...defaultPairPromotedDeps, ...(opts.deps ?? {}) };
  try {
    if (opts.landerType === "pdp") {
      return { ok: false, reason: "lander_type_not_advertorial_family" };
    }
    const archetype = archetypeForPromotedLanderType(opts.landerType);

    const { data: angles } = await admin
      .from("product_ad_angles")
      .select("id, hook_one_liner")
      .eq("workspace_id", opts.workspaceId)
      .eq("product_id", opts.productId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1);
    const angle = ((angles ?? []) as Array<{ id: string; hook_one_liner: string | null }>)[0] ?? null;
    if (!angle) return { ok: false, reason: "no_matching_angle" };

    const namePrefix = angle.hook_one_liner ? String(angle.hook_one_liner).slice(0, 60) : opts.experimentId.slice(0, 8);
    const { data: campaign, error: cErr } = await admin
      .from("ad_campaigns")
      .insert({
        workspace_id: opts.workspaceId,
        product_id: opts.productId,
        angle_id: angle.id,
        name: `Paired · ${namePrefix} (${opts.landerType} promoted)`,
        status: "ready",
      })
      .select("id")
      .maybeSingle();
    if (cErr || !campaign) return { ok: false, reason: `ad_campaigns_insert_failed:${cErr?.message ?? "no_row"}` };
    const adCampaignId = (campaign as { id: string }).id;

    try {
      await deps.sendInngest({
        name: "ad-tool/static-requested",
        data: { workspace_id: opts.workspaceId, campaign_id: adCampaignId, archetype },
      });
    } catch {
      /* persisted state is what matters; the maker can be re-triggered */
    }

    await deps.recordActivity(admin, {
      workspaceId: opts.workspaceId,
      directorFunction: "growth",
      actionKind: PAIRED_WINNER_LANDER_ACTION_KIND,
      specSlug: opts.specSlug ?? null,
      reason:
        `Promoted lander variant on ${opts.landerType} (experiment=${opts.experimentId}) — paired with fresh ` +
        `${archetype} static on ad_campaigns ${adCampaignId.slice(0, 8)} (angle ${angle.id.slice(0, 8)}).`,
      metadata: {
        direction: "lander_to_ad",
        experiment_id: opts.experimentId,
        variant_id: opts.variantId,
        lander_type: opts.landerType,
        product_id: opts.productId,
        angle_id: angle.id,
        ad_campaign_id: adCampaignId,
        archetype,
        autonomous: true,
      },
    });

    return { ok: true, ad_campaign_id: adCampaignId, angle_id: angle.id, archetype };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) };
  }
}

// ── Persist-to-renewal offer lever (storefront-renewal-offer-lever) ─────────────
// The OFFER lever is the highest-stakes one — it bleeds margin on every renewal — so it is ALWAYS
// approval-gated AND runs behind a workspace margin floor. This file owns the deterministic write
// side (propose / activate / expire / rollback) of the lever; the box session proposes the offer
// terms, the worker calls these helpers on the gate's verdict.
//
// Lifecycle:
//   propose  →  proposeRenewalOfferCampaign   inserts pricing_rule_offers (status='proposed') +
//                                              the experiment shell (storefront_experiments + arms,
//                                              status='draft' until owner approval), linking the
//                                              variant arm's id back onto the offer row.
//   approve  →  activateRenewalOfferCampaign  flips the offer 'proposed'→'active' (+ stamps
//                                              approved_by/at + activated_at) and the experiment
//                                              'draft'→'running'. Now in-window renewals see the
//                                              offer (resolveSubscriptionPricing) and the M1 refresh
//                                              attributes outcomes on the LTV proxy.
//   expire   →  expireRenewalOffers           sweeps active rows past ends_at → 'expired' (+
//                                              deactivation_reason='auto_expire') and NULLs every
//                                              subscriptions.pricing_offer_id referencing them.
//   rollback →  rollbackRenewalOffersForExperiment   on M1 LTV/refund-spike auto-rollback (or a kill),
//                                              expires the linked offer + NULLs sub references so the
//                                              renewal-margin bleed STOPS within the next refresh cycle.

/** A modeled-margin check result attached to a proposed offer (storefront-renewal-offer-lever P2).
 *  `cogs_source_missing=true` means the product had no COGS source available — the floor SOFT-passes
 *  but the audit honestly records the unknown so the approving owner can see it.  */
export interface RenewalOfferMarginCheck {
  ok: boolean;
  modeled_renewal_margin_pct: number | null;
  floor_pct: number;
  cogs_source_missing: boolean;
  reason: string;
}

/** A best-effort modeled renewal margin for an offer (storefront-renewal-offer-lever P2 guardrail).
 *  Today the product/variants tables carry no COGS column (cogs_source_missing reads true on this
 *  workspace), so this returns null/soft-pass and the audit trail records the gap — the floor will
 *  bite once COGS lands. When COGS becomes available the implementation slots in here without a
 *  caller change. */
export async function computeModeledRenewalMargin(opts: {
  workspaceId: string;
  productId: string;
  offer: OfferPlan;
  admin?: Admin;
  /** The floor the worker compares against (storefront_optimizer_policy.min_renewal_margin_pct). */
  floorPct: number;
}): Promise<RenewalOfferMarginCheck> {
  const admin = opts.admin ?? createAdminClient();
  // Best-effort COGS lookup. The shipped product/variants tables have no cogs column today, so this
  // pattern degrades cleanly: any future COGS column lights up the floor automatically.
  let cogsCents: number | null = null;
  try {
    const { data: variantRow } = await admin
      .from("product_variants")
      .select("price_cents")
      .eq("product_id", opts.productId)
      .limit(1)
      .maybeSingle();
    void variantRow;
    // No COGS source on this row — placeholder for the future column. Until then the floor soft-passes.
  } catch {
    /* fall through to cogs_source_missing */
  }
  if (cogsCents == null) {
    return {
      ok: true,
      modeled_renewal_margin_pct: null,
      floor_pct: opts.floorPct,
      cogs_source_missing: true,
      reason: "COGS source missing — modeled renewal margin not verifiable; the audit records this honestly. The floor will bite once COGS lands.",
    };
  }
  // Future path (cogs available): compute the per-unit renewal price under the offer and the resulting margin.
  // For now this branch is unreachable; left as a known-pure stub for clarity.
  const margin = 1; // placeholder
  return {
    ok: margin >= opts.floorPct,
    modeled_renewal_margin_pct: margin,
    floor_pct: opts.floorPct,
    cogs_source_missing: false,
    reason: margin >= opts.floorPct
      ? `modeled renewal margin ${(margin * 100).toFixed(1)}% ≥ floor ${(opts.floorPct * 100).toFixed(0)}%`
      : `modeled renewal margin ${(margin * 100).toFixed(1)}% BELOW floor ${(opts.floorPct * 100).toFixed(0)}% — escalating to Growth + CFO, NOT surfacing as a normal proposal`,
  };
}

export interface RenewalOfferProposalResult {
  ok: boolean;
  offer_id?: string;
  experiment_id?: string;
  variant_id?: string;
  margin: RenewalOfferMarginCheck | null;
  detail: string;
}

/**
 * Stand up a persist-to-renewal offer campaign in `proposed`/`draft` shape (no live serving yet).
 * Two rows + the linkage:
 *   1. pricing_rule_offers (status='proposed', experiment_id + variant_id wired)
 *   2. storefront_experiments (status='draft' — the campaign record M5 grades) + control arm + offer arm
 * The offer arm carries an empty content patch (the offer is the lever, not a content change). On
 * `approve`, the worker calls `activateRenewalOfferCampaign` which flips the offer → active and the
 * experiment → running, so the offer arm starts serving the in-window delta to renewals.
 *
 * Margin floor: when the modeled margin is below the policy's `min_renewal_margin_pct`, this REFUSES
 * the proposal (returns {ok:false}) — the caller is expected to escalate to Growth + CFO (a
 * director_activity 'escalated_margin_breach' row) instead of surfacing a normal proposal. A missing
 * COGS source soft-passes (cogs_source_missing=true on the row); the audit records that the floor
 * wasn't verifiable. Operational-rules § North star: a hard rail = escalate, not execute.
 */
export async function proposeRenewalOfferCampaign(opts: {
  workspaceId: string;
  productId: string;
  proposal: OptimizerProposal;
  conservative: boolean;
  floorPct: number;
  createdBy?: string | null;
  now?: Date;
  admin?: Admin;
}): Promise<RenewalOfferProposalResult> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  const p = opts.proposal;
  const offer = p.variant.offer;
  if (!offer) {
    return { ok: false, margin: null, detail: "offer variant missing offer terms" };
  }
  if (offer.offer_type === "subscribe_discount_pct" && offer.subscribe_discount_pct == null) {
    return { ok: false, margin: null, detail: "subscribe_discount_pct offer missing the % value" };
  }
  if (offer.offer_type === "fixed_renewal_price" && offer.renewal_price_cents == null) {
    return { ok: false, margin: null, detail: "fixed_renewal_price offer missing the price (cents)" };
  }
  const endsAt = new Date(offer.ends_at);
  if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= now.getTime()) {
    return { ok: false, margin: null, detail: "offer.ends_at must be a future ISO timestamp" };
  }

  const surface: OptimizerSurface = {
    workspace_id: opts.workspaceId,
    product_id: opts.productId,
    lander_type: p.lander_type,
    audience: p.audience,
  };
  if (await hasActiveCampaignForSurface(admin, surface)) {
    return { ok: false, margin: null, detail: `a campaign is already active on ${surfaceKey(surface)} — not standing up a second` };
  }

  // ── Margin-floor hard rail ─────────────────────────────────────────────────
  const margin = await computeModeledRenewalMargin({
    workspaceId: opts.workspaceId,
    productId: opts.productId,
    offer,
    floorPct: opts.floorPct,
    admin,
  });
  if (!margin.ok) {
    // Below the floor: the caller escalates instead of surfacing.
    return { ok: false, margin, detail: margin.reason };
  }

  let holdout = typeof p.holdout_pct === "number" ? p.holdout_pct : 0.1;
  holdout = Math.min(0.9, Math.max(0.05, holdout));
  if (opts.conservative) holdout = Math.max(holdout, CONSERVATIVE_MIN_HOLDOUT);

  // 1. The experiment shell (draft until owner approves the offer — nothing serves yet).
  const { data: expRow, error: expErr } = await admin
    .from("storefront_experiments")
    .insert({
      workspace_id: opts.workspaceId,
      product_id: opts.productId,
      lander_type: p.lander_type,
      audience: p.audience,
      lever: p.lever_key,
      hypothesis: p.hypothesis,
      status: "draft",
      holdout_pct: holdout,
      created_by: opts.createdBy ?? null,
      last_decision: {
        action: "proposed_offer",
        by: "storefront-optimizer",
        lever_class: "offer",
        reasoning: p.reasoning,
        conservative: opts.conservative,
        offer_type: offer.offer_type,
        at: now.toISOString(),
      },
    })
    .select("id")
    .single();
  if (expErr || !expRow) {
    return { ok: false, margin, detail: `experiment insert failed: ${expErr?.message ?? "no row"}` };
  }
  const experimentId = expRow.id as string;

  // 2. Control arm (base pricing) + the offer arm (the offer carries the lever — empty content patch).
  const { data: variantRows, error: varErr } = await admin
    .from("storefront_experiment_variants")
    .insert([
      { experiment_id: experimentId, workspace_id: opts.workspaceId, label: "control", is_control: true, patch: {} },
      {
        experiment_id: experimentId,
        workspace_id: opts.workspaceId,
        label: p.variant.label || "renewal-offer",
        is_control: false,
        patch: {},
      },
    ])
    .select("id, is_control");
  if (varErr || !variantRows) {
    await admin.from("storefront_experiments").delete().eq("id", experimentId);
    return { ok: false, margin, detail: `variant insert failed (experiment rolled back): ${varErr?.message ?? "no rows"}` };
  }
  const variantId =
    (variantRows as Array<{ id: string; is_control: boolean }>).find((v) => !v.is_control)?.id ?? "";
  if (!variantId) {
    await admin.from("storefront_experiments").delete().eq("id", experimentId);
    return { ok: false, margin, detail: "could not resolve the offer arm variant id" };
  }

  // 3. The pricing_rule_offers row (status='proposed' — inactive until owner approval).
  const offerInsert: Record<string, unknown> = {
    workspace_id: opts.workspaceId,
    product_id: opts.productId,
    experiment_id: experimentId,
    variant_id: variantId,
    lander_type: p.lander_type,
    audience: p.audience,
    offer_type: offer.offer_type,
    subscribe_discount_pct: offer.offer_type === "subscribe_discount_pct" ? offer.subscribe_discount_pct : null,
    renewal_price_cents: offer.offer_type === "fixed_renewal_price" ? offer.renewal_price_cents : null,
    ends_at: endsAt.toISOString(),
    status: "proposed",
    modeled_renewal_margin_pct: margin.modeled_renewal_margin_pct,
    margin_floor_pct: margin.floor_pct,
    margin_floor_ok: margin.ok && !margin.cogs_source_missing ? true : null,
    cogs_source_missing: margin.cogs_source_missing,
    hypothesis: p.hypothesis,
    rationale: offer.rationale ?? p.reasoning,
    created_by: opts.createdBy ?? null,
  };
  const { data: offerRow, error: offerErr } = await admin
    .from("pricing_rule_offers")
    .insert(offerInsert)
    .select("id")
    .single();
  if (offerErr || !offerRow) {
    // Roll the rest back so the surface isn't left half-stood-up.
    await admin.from("storefront_experiments").delete().eq("id", experimentId);
    return { ok: false, margin, detail: `pricing_rule_offers insert failed (experiment + arms rolled back): ${offerErr?.message ?? "no row"}` };
  }
  const offerId = offerRow.id as string;

  return {
    ok: true,
    offer_id: offerId,
    experiment_id: experimentId,
    variant_id: variantId,
    margin,
    detail: `proposed offer ${offerId} on ${surfaceKey(surface)} — lever ${p.lever_key}, holdout ${holdout}${opts.conservative ? " (conservative)" : ""} (awaiting owner approval)`,
  };
}

export interface RenewalOfferActivationResult {
  ok: boolean;
  detail: string;
}

/**
 * On owner approval, flip the proposed offer + draft experiment LIVE:
 *  - pricing_rule_offers.status: 'proposed' → 'active', activated_at = now(), approved_by/_at set
 *  - storefront_experiments.status: 'draft' → 'running', started_at = now()
 *
 * Idempotent at the offer grain: re-running on an already-active row is a no-op (the worker can
 * safely retry an approval handler). Best-effort republish of the edge manifest for PDP arms so
 * the offer arm starts serving immediately (the offer's persistent effect is at RENEWAL — first-
 * order pricing is unchanged unless the offer is also a first-order discount, which the
 * coupons path handles separately).
 */
export async function activateRenewalOfferCampaign(opts: {
  workspaceId: string;
  offerId: string;
  approvedBy?: string | null;
  now?: Date;
  admin?: Admin;
}): Promise<RenewalOfferActivationResult> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();

  const { data: offer, error: loadErr } = await admin
    .from("pricing_rule_offers")
    .select("id, status, experiment_id, product_id, lander_type, ends_at")
    .eq("id", opts.offerId)
    .eq("workspace_id", opts.workspaceId)
    .maybeSingle();
  if (loadErr || !offer) {
    return { ok: false, detail: `offer ${opts.offerId} not found: ${loadErr?.message ?? "no row"}` };
  }
  if (offer.status === "active") {
    return { ok: true, detail: `offer ${opts.offerId} already active — idempotent no-op` };
  }
  if (offer.status === "expired") {
    return { ok: false, detail: `offer ${opts.offerId} is expired — cannot activate; propose a fresh offer` };
  }
  if (Date.parse(offer.ends_at as string) <= now.getTime()) {
    return { ok: false, detail: `offer ${opts.offerId} ends_at is already in the past — cannot activate` };
  }

  const { error: offerErr } = await admin
    .from("pricing_rule_offers")
    .update({
      status: "active",
      approved_by: opts.approvedBy ?? null,
      approved_at: now.toISOString(),
      activated_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", opts.offerId);
  if (offerErr) {
    return { ok: false, detail: `offer activation failed: ${offerErr.message}` };
  }

  if (offer.experiment_id) {
    const { error: expErr } = await admin
      .from("storefront_experiments")
      .update({ status: "running", started_at: now.toISOString(), updated_at: now.toISOString() })
      .eq("id", offer.experiment_id as string)
      .eq("status", "draft");
    if (expErr) {
      return { ok: false, detail: `experiment activation failed: ${expErr.message}` };
    }
  }

  if (offer.lander_type === "pdp") {
    await republishExperimentManifest(admin, [offer.product_id as string]);
  }

  return {
    ok: true,
    detail: `activated offer ${opts.offerId} — experiment ${offer.experiment_id ?? "(none)"} now running; renewals in [now, ends_at] apply the offer`,
  };
}

export interface RenewalOfferSweepResult {
  expired: number;
  subscriptions_unlinked: number;
}

/**
 * Auto-expire every active persist-to-renewal offer whose `ends_at` has passed (the Phase 2
 * safety net — every offer is explicitly time-boxed and never silently becomes the default price).
 *  - pricing_rule_offers: status='expired', expired_at=now(), deactivation_reason='auto_expire'
 *  - subscriptions.pricing_offer_id → NULL for every sub referencing the expired offer (a reference,
 *    not a baked price → the sub reverts to base pricing on its next renewal automatically).
 *
 * Idempotent: only acts on `active` rows past their ends_at; subsequent runs find none. Best-effort
 * (an offer-row failure logs + continues; one bad row doesn't strand the sweep).
 */
export async function expireRenewalOffers(opts: {
  workspaceId: string;
  now?: Date;
  admin?: Admin;
}): Promise<RenewalOfferSweepResult> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();

  const { data: dueRows } = await admin
    .from("pricing_rule_offers")
    .select("id")
    .eq("workspace_id", opts.workspaceId)
    .eq("status", "active")
    .lte("ends_at", now.toISOString());
  const ids = ((dueRows as Array<{ id: string }>) || []).map((r) => r.id);
  let expired = 0;
  let unlinked = 0;
  for (const offerId of ids) {
    const { error: upErr } = await admin
      .from("pricing_rule_offers")
      .update({
        status: "expired",
        expired_at: now.toISOString(),
        deactivation_reason: "auto_expire",
        updated_at: now.toISOString(),
      })
      .eq("id", offerId)
      .eq("status", "active"); // belt-and-suspenders: don't flip a concurrently-mutated row
    if (upErr) {
      console.warn(`[storefront-optimizer] auto-expire offer ${offerId} failed: ${upErr.message}`);
      continue;
    }
    expired++;
    // Clear the reference on every sub that pointed at this offer — they revert to base pricing.
    const { data: unlinkRows, error: subErr } = await admin
      .from("subscriptions")
      .update({ pricing_offer_id: null })
      .eq("workspace_id", opts.workspaceId)
      .eq("pricing_offer_id", offerId)
      .select("id");
    if (subErr) {
      console.warn(`[storefront-optimizer] auto-expire offer ${offerId} sub-unlink failed: ${subErr.message}`);
      continue;
    }
    unlinked += (unlinkRows?.length ?? 0);
  }
  return { expired, subscriptions_unlinked: unlinked };
}

/**
 * Roll back every persist-to-renewal offer linked to an experiment that just got auto-rolled-back
 * (LTV regression / refund spike — experiment-refresh Phase 5) OR killed. Expires the offer
 * (`deactivation_reason='experiment_rollback'`) and clears `subscriptions.pricing_offer_id` for
 * affected subs so the renewal-margin bleed STOPS within the next refresh cycle. A persist-to-renewal
 * offer touched real renewals — rollback must un-touch them.
 */
/**
 * Resolve the persist-to-renewal offer this checkout's subscriber qualifies for, if any
 * (storefront-renewal-offer-lever — the checkout-side wiring of subscriptions.pricing_offer_id).
 *
 * A sub gets stamped with `pricing_offer_id` only when:
 *   1. The visitor's storefront_sessions row carries an experiment assignment on the OFFER ARM
 *      (arm === 'variant') of a RUNNING offer experiment,
 *   2. AND the offer experiment's product matches one of the products on this sub,
 *   3. AND there is an `active`, in-window pricing_rule_offers row scoped to that experiment+variant.
 *
 * Returns the offer_id (the first match — at most one offer per sub; checkout never bundles two
 * persist-to-renewal offers into one sub). Returns null if no qualifying offer is found, the
 * anonymous_id is missing, or anything errors (the path is best-effort: a failure here means the
 * sub renews at base pricing, never a wrong price).
 */
export async function resolveSubscriptionOfferId(opts: {
  workspaceId: string;
  anonymousId: string | null;
  customerId?: string | null;
  productIds: string[];
  now?: Date;
  admin?: Admin;
}): Promise<string | null> {
  if (!opts.anonymousId && !opts.customerId) return null;
  if (!opts.productIds.length) return null;
  try {
    const admin = opts.admin ?? createAdminClient();
    const now = opts.now ?? new Date();
    // Find the converting session's experiment assignments. Prefer anonymous_id (the stable
    // pre-purchase identity); fall back to customer_id if it's not available.
    let sessQuery = admin
      .from("storefront_sessions")
      .select("experiment_assignments")
      .eq("workspace_id", opts.workspaceId)
      .order("last_seen_at", { ascending: false })
      .limit(1);
    if (opts.anonymousId) {
      sessQuery = sessQuery.eq("anonymous_id", opts.anonymousId);
    } else if (opts.customerId) {
      sessQuery = sessQuery.eq("customer_id", opts.customerId);
    }
    const { data: sess } = await sessQuery.maybeSingle();
    const assignments = (sess as { experiment_assignments?: Array<{ experiment_id: string; variant_id: string; arm: string }> } | null)?.experiment_assignments;
    if (!assignments?.length) return null;
    // Offer arms only: arm === 'variant' (holdout + control never carry the offer).
    const variantArms = assignments.filter((a) => a.arm === "variant" && a.experiment_id && a.variant_id);
    if (!variantArms.length) return null;
    const experimentIds = variantArms.map((a) => a.experiment_id);
    const variantIds = new Set(variantArms.map((a) => a.variant_id));
    const { data: offers } = await admin
      .from("pricing_rule_offers")
      .select("id, experiment_id, variant_id, product_id, starts_at, ends_at, status")
      .eq("workspace_id", opts.workspaceId)
      .eq("status", "active")
      .in("experiment_id", experimentIds)
      .in("product_id", opts.productIds);
    const nowMs = now.getTime();
    for (const o of (offers as Array<{ id: string; experiment_id: string; variant_id: string; product_id: string; starts_at: string | null; ends_at: string | null; status: string }> | null) ?? []) {
      if (!variantIds.has(o.variant_id)) continue;
      const startsOk = !o.starts_at || Date.parse(o.starts_at) <= nowMs;
      const endsOk = !o.ends_at || Date.parse(o.ends_at) > nowMs;
      if (startsOk && endsOk) return o.id;
    }
    return null;
  } catch (e) {
    console.warn(`[storefront-optimizer] resolveSubscriptionOfferId failed: ${errText(e)}`);
    return null;
  }
}

export async function rollbackRenewalOffersForExperiment(opts: {
  workspaceId: string;
  experimentId: string;
  reason: string;
  now?: Date;
  admin?: Admin;
}): Promise<RenewalOfferSweepResult> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();

  const { data: rows } = await admin
    .from("pricing_rule_offers")
    .select("id")
    .eq("workspace_id", opts.workspaceId)
    .eq("experiment_id", opts.experimentId)
    .in("status", ["proposed", "approved", "active"]);
  const ids = ((rows as Array<{ id: string }>) || []).map((r) => r.id);
  let expired = 0;
  let unlinked = 0;
  for (const offerId of ids) {
    const { error: upErr } = await admin
      .from("pricing_rule_offers")
      .update({
        status: "expired",
        expired_at: now.toISOString(),
        deactivation_reason: `experiment_rollback: ${opts.reason}`.slice(0, 240),
        updated_at: now.toISOString(),
      })
      .eq("id", offerId);
    if (upErr) {
      console.warn(`[storefront-optimizer] rollback offer ${offerId} failed: ${upErr.message}`);
      continue;
    }
    expired++;
    const { data: unlinkRows, error: subErr } = await admin
      .from("subscriptions")
      .update({ pricing_offer_id: null })
      .eq("workspace_id", opts.workspaceId)
      .eq("pricing_offer_id", offerId)
      .select("id");
    if (subErr) {
      console.warn(`[storefront-optimizer] rollback offer ${offerId} sub-unlink failed: ${subErr.message}`);
      continue;
    }
    unlinked += (unlinkRows?.length ?? 0);
  }
  return { expired, subscriptions_unlinked: unlinked };
}
