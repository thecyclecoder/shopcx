/**
 * Storefront campaign grader — the Head-of-Growth supervisory grading loop (M5 of the
 * storefront-optimizer goal, docs/brain/specs/storefront-campaign-grading-loop.md).
 *
 * Closes the CEO → Growth → Optimizer chain: an AI grader scores each CONCLUDED M4 campaign
 * 1–10 against a rubric + human-approved calibration rules (the [[storefront_grader_prompts]]
 * store), exactly mirroring the shipped 1–10 ticket grader ([[ticket-analyzer]] `analyzeTicket`
 * + the [[grader_prompts]] calibration arc). The grade is the FEEDBACK SIGNAL of the M4 agent.
 *
 * The defining invariant: HYPOTHESIS QUALITY is scored SEPARATELY from RESULT. A sound
 * hypothesis that lost is good learning (high `hypothesis_quality`); a lucky win from a
 * sloppy hypothesis is low. The grader must not reward outcome luck.
 *
 * Two grades per campaign, BOTH KEPT:
 *   • initial  — at significance, on the predicted-LTV proxy + the agent's cited reasoning.
 *   • revised  — ~4 months later, once the [[storefront-ltv-reconciler|M3 reconciler]] lands
 *                the cohort's actual LTV: did the proxy-time call hold up? A large
 *                initial-vs-revised gap proposes a `storefront_grader_prompts` calibration rule.
 *
 * The grader is a SUPERVISED TOOL ([[operational-rules]] § North star): it scores a bounded
 * proxy (campaign quality); the Growth director owns the objective and overrides it. Every
 * grade is human-overridable and the override is recorded (`graded_by='human'`/`overridden_by`)
 * — never silently lost.
 *
 * Idempotent per (campaign × mode): a re-run UPDATEs the grade row in place, never duplicates.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { logAiUsage, usageCostCents } from "@/lib/ai-usage";
import { SONNET_MODEL, OPUS_MODEL } from "@/lib/ai-models";

type Admin = ReturnType<typeof createAdminClient>;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GRADER_MODEL = SONNET_MODEL;
/** The `model` stamp for a grade produced by the box-hosted grader (Max session — no API bill).
 *  Mirrors [[agent-grader]] BOX_GRADE_MODEL and [[director-grader]] BOX_DIRECTOR_GRADE_MODEL so a
 *  box-vs-API split stays queryable in dashboards. grading-cascade-to-box-sessions Phase 4. */
const BOX_CAMPAIGN_GRADE_MODEL = "box-max-session";

/** An initial-vs-revised grade gap at/above this magnitude proposes a calibration rule —
 *  the proxy-time call diverged enough from reality that the rubric likely needs a correction. */
export const REVISED_GAP_RULE_THRESHOLD = 3;

/** Cap on how many campaigns one batched box grading session grades. Mirrors GRADE_BATCH_CAP /
 *  DIRECTOR_GRADE_BATCH_CAP — kept small: a Max session reading each experiment's rollups + variants
 *  + optional reconciliation row is roughly a build-sized read per campaign. */
const CAMPAIGN_GRADE_BATCH_CAP = 8;

export type GradeMode = "initial" | "revised";

export interface CampaignGradeResult {
  ok: boolean;
  reason?: string;
  grade_id?: string;
  mode?: GradeMode;
  grade?: number;
  hypothesis_quality?: number;
  result_quality?: number;
  idempotent_update?: boolean;
}

interface GraderJson {
  grade: number;
  hypothesis_quality: number;
  result_quality: number;
  reasoning: string;
}

interface ExperimentRow {
  id: string;
  workspace_id: string;
  product_id: string;
  lander_type: string;
  audience: string;
  lever: string;
  hypothesis: string | null;
  status: string;
  holdout_pct: number;
  last_decision: Record<string, unknown> | null;
  started_at: string | null;
  stopped_at: string | null;
}

interface VariantRow {
  label: string;
  is_control: boolean;
  patch: Record<string, unknown>;
  sessions: number;
  conversions: number;
  sub_attach: number;
  revenue_cents: number;
  ltv_proxy_cents: number;
}

/**
 * Build the campaign grader system prompt: the static rubric + any APPROVED
 * `storefront_grader_prompts` calibration rules (learned from Growth-director overrides +
 * large proxy-vs-reality gaps). Mirrors [[ticket-analyzer]] `buildGraderSystemPrompt`.
 */
export async function buildCampaignGraderSystemPrompt(admin: Admin, workspaceId: string, mode: GradeMode): Promise<string> {
  const { data: rules } = await admin
    .from("storefront_grader_prompts")
    .select("title, content")
    .eq("workspace_id", workspaceId)
    .eq("status", "approved")
    .order("sort_order", { ascending: true });

  const rulesBlock = (rules || []).length
    ? "\n\nCALIBRATION RULES (apply these — they are Growth-director-approved adjustments to the rubric):\n\n" +
      (rules || []).map((r) => `• ${r.title}\n  ${r.content}`).join("\n\n")
    : "";

  const modeBlock =
    mode === "initial"
      ? `You are grading at SIGNIFICANCE — the moment the bandit concluded the campaign on the predicted-LTV proxy. The "actual" 4-month LTV is NOT known yet, so grade RESULT on the proxy outcome only.`
      : `You are RE-GRADING the same campaign ~4 months later, now that the actual realized LTV has landed (the M3 reconciler truth-checked the proxy). Judge whether the proxy-time call HELD UP: a hypothesis the proxy said won but reality says lost should see its result_quality fall; one that quietly compounded should rise. The HYPOTHESIS quality rarely changes on revision — it was sound or sloppy at design time regardless of how the number landed.`;

  return `You are the Head of Growth grading on-site storefront optimization campaigns run by an autonomous optimizer agent. Each campaign is ONE atomic hypothesis: the agent read the funnel + its learned lever-importance posterior, formed a CRO hypothesis, stood up an A/B experiment vs a holdout, and the bandit concluded it (promote / kill / rollback).

${modeBlock}

THE DEFINING RULE — GRADE HYPOTHESIS QUALITY SEPARATELY FROM RESULT:
  • hypothesis_quality (1-10): was the BET sound at design time? Did it cite a real funnel signal / lever posterior, target a high-leverage lever, form a falsifiable, well-reasoned CRO hypothesis, and size the holdout sensibly? A SOUND hypothesis that LOST is good learning → score this HIGH regardless of the result. A lucky win from a sloppy, unreasoned, or fishing-expedition hypothesis → score this LOW regardless of the result.
  • result_quality (1-10): how did the campaign actually perform on the reward (predicted-LTV-per-visitor lift vs control${mode === "revised" ? ", reconciled against the 4-month actual LTV" : ""}), accounting for statistical strength (exposure, win-probability) — not just the point estimate?
  • grade (1-10): the overall campaign grade. Weight hypothesis quality at least as heavily as result — we are training an agent to make SOUND BETS, not to get lucky. Do NOT reward outcome luck; do NOT punish a sound bet that lost.

SCORING (1-10), each axis:
  10 — exemplary. 8-9 — strong. 6-7 — acceptable. 4-5 — mediocre. 2-3 — poor. 1 — indefensible.

HARD RULES:
  • A well-reasoned hypothesis grounded in a cited funnel signal + lever posterior that LOST on the proxy still earns a HIGH hypothesis_quality (sound learning).
  • A win with NO coherent prior reasoning (no cited signal, an off-policy or scattershot lever) earns a LOW hypothesis_quality even though result_quality is high.
  • Thin exposure / a marginal win-probability caps result_quality at 6 — an underpowered "win" is not a real result.${rulesBlock}

OUTPUT (JSON only, no prose around it):
{
  "grade": <integer 1-10>,
  "hypothesis_quality": <integer 1-10>,
  "result_quality": <integer 1-10>,
  "reasoning": "<2-4 sentences: why this hypothesis was sound or sloppy, and how the result reads — kept distinct>"
}`;
}

/** A compact, gradeable description of the campaign: the hypothesis + cited reasoning, the
 *  variant produced, the lever + its learned posterior, and the arm rollups (the proxy result). */
function formatCampaignForGrading(
  exp: ExperimentRow,
  variants: VariantRow[],
  posterior: { importance: number; prior: number; n_tests: number } | null,
  reconciliation: { proxy_ltv_cents: number; actual_ltv_cents: number; error_pct: number } | null,
): string {
  const ltvPerSession = (v: VariantRow) => (v.sessions > 0 ? Math.round(v.ltv_proxy_cents / v.sessions) : 0);
  const cvr = (v: VariantRow) => (v.sessions > 0 ? Math.round((v.conversions / v.sessions) * 1000) / 10 : 0);
  const control = variants.find((v) => v.is_control);
  const arms = variants.filter((v) => !v.is_control);
  const decision = exp.last_decision || {};
  const reasoning = typeof decision.reasoning === "string" ? decision.reasoning : "(none recorded)";
  const leverClass = typeof decision.lever_class === "string" ? decision.lever_class : "(unknown)";

  const armLines = variants.map(
    (v) =>
      `    - ${v.label}${v.is_control ? " (control/holdout)" : ""}: sessions=${v.sessions}, cvr=${cvr(v)}%, sub_attach=${v.sub_attach}, ltv_proxy/session=${ltvPerSession(v)}¢`,
  );

  const controlLtv = control ? ltvPerSession(control) : 0;
  const bestArm = arms.sort((a, b) => ltvPerSession(b) - ltvPerSession(a))[0];
  const bestLtv = bestArm ? ltvPerSession(bestArm) : 0;
  const relLift = controlLtv > 0 ? Math.round(((bestLtv - controlLtv) / controlLtv) * 1000) / 10 : null;

  return [
    `CAMPAIGN — experiment ${exp.id}`,
    `  surface: product=${exp.product_id} · lander=${exp.lander_type} · audience=${exp.audience}`,
    `  lever under test: ${exp.lever} (class=${leverClass})`,
    posterior
      ? `  lever posterior at design time: importance=${posterior.importance} (prior=${posterior.prior}, n_tests=${posterior.n_tests})`
      : `  lever posterior at design time: (no learned posterior — cold start on the CRO prior)`,
    `  holdout: ${Math.round((exp.holdout_pct || 0) * 100)}%`,
    ``,
    `  HYPOTHESIS (the agent's bet): ${exp.hypothesis || "(none recorded)"}`,
    `  CITED REASONING (funnel signal + lever posterior): ${reasoning}`,
    ``,
    `  VARIANT PRODUCED: ${arms.map((a) => `${a.label} → patch ${JSON.stringify(a.patch).slice(0, 300)}`).join(" | ") || "(none)"}`,
    ``,
    `  PROXY RESULT (the reward = predicted-LTV-per-visitor):`,
    ...armLines,
    `    best-arm vs control relative LTV-proxy lift: ${relLift === null ? "n/a" : `${relLift}%`}`,
    `  BANDIT DECISION: status=${exp.status}, action=${String(decision.action ?? "?")}, rule=${String(decision.rule ?? "?")}, win_prob=${String(decision.win_prob ?? "n/a")}`,
    reconciliation
      ? `\n  ACTUAL 4-MONTH LTV (M3 reconciler): proxy=${reconciliation.proxy_ltv_cents}¢/visitor vs actual=${reconciliation.actual_ltv_cents}¢/visitor (error_pct=${reconciliation.error_pct} — ${reconciliation.error_pct < 0 ? "proxy OVER-predicted" : "proxy UNDER-predicted"})`
      : ``,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Load the lever-importance posterior for the campaign's cell (design-time belief context). */
async function loadLeverPosterior(admin: Admin, exp: ExperimentRow): Promise<{ importance: number; prior: number; n_tests: number } | null> {
  try {
    const { data: lever } = await admin.from("storefront_levers").select("id").eq("lever_key", exp.lever).maybeSingle();
    if (!lever) return null;
    const { data } = await admin
      .from("storefront_lever_importance")
      .select("importance, prior, n_tests")
      .eq("lever_id", lever.id)
      .eq("product_id", exp.product_id)
      .eq("lander_type", exp.lander_type)
      .eq("audience", exp.audience)
      .maybeSingle();
    return (data as { importance: number; prior: number; n_tests: number }) ?? null;
  } catch {
    return null;
  }
}

/** The most recent reconciliation row for the campaign's cohort (revised-mode context). */
async function loadCohortReconciliation(
  admin: Admin,
  exp: ExperimentRow,
): Promise<{ proxy_ltv_cents: number; actual_ltv_cents: number; error_pct: number } | null> {
  try {
    const { data } = await admin
      .from("storefront_ltv_reconciliations")
      .select("proxy_ltv_cents, actual_ltv_cents, error_pct, cohort_snapshot_date")
      .eq("workspace_id", exp.workspace_id)
      .eq("product_id", exp.product_id)
      .eq("lander_type", exp.lander_type)
      .eq("audience", exp.audience)
      .order("cohort_snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as { proxy_ltv_cents: number; actual_ltv_cents: number; error_pct: number }) ?? null;
  } catch {
    return null;
  }
}

/** Call the LLM grader and parse the strict JSON. */
async function runGrader(system: string, userMsg: string, workspaceId: string): Promise<{ json: GraderJson; costCents: number; usage: unknown } | { error: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GRADER_MODEL,
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  if (!res.ok) return { error: `grader_http_${res.status}` };

  const data = await res.json();
  const text = (data.content?.[0] as { text?: string })?.text?.trim() || "";
  const usage = data.usage;
  const costCents = usage
    ? usageCostCents(GRADER_MODEL, {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_creation_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_tokens: usage.cache_read_input_tokens || 0,
      })
    : 0;
  await logAiUsage({ workspaceId, model: GRADER_MODEL, usage, purpose: "storefront_campaign_grading" });

  let parsed: GraderJson | null = null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]) as GraderJson;
  } catch {
    /* fall through */
  }
  const valid =
    parsed &&
    [parsed.grade, parsed.hypothesis_quality, parsed.result_quality].every((n) => typeof n === "number" && n >= 1 && n <= 10);
  if (!valid) return { error: "parse_failed" };
  return { json: parsed as GraderJson, costCents, usage };
}

function clampGrade(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)));
}

/**
 * Grade ONE concluded campaign, in `initial` or `revised` mode. Idempotent per (campaign × mode):
 * the row is keyed on `experiment_id`; an initial re-grade updates the initial columns in place,
 * a revised grade fills the revised columns WITHOUT touching the initial ones (both persist).
 *
 * A human override is never clobbered: once `graded_by='human'`, the agent will not re-write the
 * initial grade (the Growth director owns it) — it still lands a revised grade if absent.
 */
export async function gradeCampaign(opts: {
  experimentId: string;
  mode: GradeMode;
  admin?: Admin;
}): Promise<CampaignGradeResult> {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: "no_api_key" };
  const admin = opts.admin ?? createAdminClient();
  const mode = opts.mode;

  const { data: exp } = await admin
    .from("storefront_experiments")
    .select("id, workspace_id, product_id, lander_type, audience, lever, hypothesis, status, holdout_pct, last_decision, started_at, stopped_at")
    .eq("id", opts.experimentId)
    .maybeSingle();
  if (!exp) return { ok: false, reason: "experiment_not_found" };
  const experiment = exp as ExperimentRow;

  // Existing grade row (idempotency + don't-clobber-human checks).
  const { data: existing } = await admin
    .from("storefront_campaign_grades")
    .select("id, grade_initial, grade_revised, graded_by")
    .eq("experiment_id", experiment.id)
    .maybeSingle();
  const existingRow = existing as
    | { id: string; grade_initial: number | null; grade_revised: number | null; graded_by: string }
    | null;

  if (mode === "revised") {
    // Need an initial grade first; and the cohort must have reconciled.
    if (!existingRow?.grade_initial) return { ok: false, reason: "no_initial_grade_yet" };
    if (existingRow.grade_revised != null) return { ok: true, grade_id: existingRow.id, mode, grade: existingRow.grade_revised, idempotent_update: true };
  }

  const reconciliation = mode === "revised" ? await loadCohortReconciliation(admin, experiment) : null;
  if (mode === "revised" && !reconciliation) return { ok: false, reason: "cohort_not_reconciled" };

  const [{ data: variantData }, posterior] = await Promise.all([
    admin
      .from("storefront_experiment_variants")
      .select("label, is_control, patch, sessions, conversions, sub_attach, revenue_cents, ltv_proxy_cents")
      .eq("experiment_id", experiment.id),
    loadLeverPosterior(admin, experiment),
  ]);
  const variants = (variantData as VariantRow[]) || [];

  const system = await buildCampaignGraderSystemPrompt(admin, experiment.workspace_id, mode);
  const userMsg = `Grade this campaign. Return the JSON only.\n\n${formatCampaignForGrading(experiment, variants, posterior, reconciliation)}`;

  const graded = await runGrader(system, userMsg, experiment.workspace_id);
  if ("error" in graded) return { ok: false, reason: graded.error };
  const g = graded.json;
  const grade = clampGrade(g.grade);
  const hypothesisQuality = clampGrade(g.hypothesis_quality);
  const resultQuality = clampGrade(g.result_quality);
  const now = new Date().toISOString();

  let gradeId = existingRow?.id;

  if (mode === "initial") {
    // Never overwrite a human-overridden initial grade.
    if (existingRow && existingRow.graded_by === "human") {
      return { ok: true, grade_id: existingRow.id, mode, grade: existingRow.grade_initial ?? grade, idempotent_update: true };
    }
    const payload = {
      workspace_id: experiment.workspace_id,
      experiment_id: experiment.id,
      grade_initial: grade,
      grade_initial_reasoning: g.reasoning,
      hypothesis_quality: hypothesisQuality,
      result_quality: resultQuality,
      initial_graded_at: now,
      graded_by: "agent" as const,
      model: GRADER_MODEL,
      input_tokens: (graded.usage as { input_tokens?: number } | undefined)?.input_tokens || 0,
      output_tokens: (graded.usage as { output_tokens?: number } | undefined)?.output_tokens || 0,
      cost_cents: graded.costCents,
      updated_at: now,
    };
    if (existingRow) {
      await admin.from("storefront_campaign_grades").update(payload).eq("id", existingRow.id);
    } else {
      const { data: ins } = await admin.from("storefront_campaign_grades").insert(payload).select("id").single();
      gradeId = ins?.id;
    }
    return { ok: true, grade_id: gradeId, mode, grade, hypothesis_quality: hypothesisQuality, result_quality: resultQuality, idempotent_update: !!existingRow };
  }

  // mode === "revised" — fill the revised columns, leave the initial grade untouched (both persist).
  await admin
    .from("storefront_campaign_grades")
    .update({
      grade_revised: grade,
      grade_revised_reasoning: g.reasoning,
      revised_graded_at: now,
      updated_at: now,
    })
    .eq("id", existingRow!.id);

  // A large initial-vs-revised gap is a calibration signal → propose a storefront_grader_prompts rule.
  const initial = existingRow!.grade_initial ?? grade;
  if (Math.abs(initial - grade) >= REVISED_GAP_RULE_THRESHOLD) {
    await proposeGapCalibrationRule(admin, {
      workspaceId: experiment.workspace_id,
      experimentId: experiment.id,
      gradeId: existingRow!.id,
      gradeInitial: initial,
      gradeRevised: grade,
      revisedReasoning: g.reasoning,
      lever: experiment.lever,
    }).catch((e) => console.warn(`[campaign-grader] gap-rule proposal failed exp=${experiment.id}: ${errText(e)}`));
  }

  return { ok: true, grade_id: existingRow!.id, mode, grade, hypothesis_quality: hypothesisQuality, result_quality: resultQuality };
}

/**
 * A large proxy-vs-reality gap on revision means the rubric mis-judged the proxy result — draft a
 * calibration rule (Opus) the Growth director can approve, mirroring the ticket-grader override
 * arc. Inserted with `status='proposed'` + provenance; only an approved rule reaches the grader.
 */
async function proposeGapCalibrationRule(
  admin: Admin,
  opts: {
    workspaceId: string;
    experimentId: string;
    gradeId: string;
    gradeInitial: number;
    gradeRevised: number;
    revisedReasoning: string;
    lever: string;
  },
): Promise<void> {
  if (!ANTHROPIC_API_KEY) return;
  const prompt = `An autonomous storefront optimizer ran a campaign testing the "${opts.lever}" lever. At significance the campaign grader gave an INITIAL grade of ${opts.gradeInitial}/10 on the predicted-LTV proxy. ~4 months later, once the ACTUAL realized LTV landed, the REVISED grade was ${opts.gradeRevised}/10. The revised reasoning: "${opts.revisedReasoning}"

This is a large proxy-vs-reality gap, which means the grader's rubric likely mis-weighted something at proxy time. Propose a SHORT calibration rule to add to the campaign grader's system prompt so it judges similar future campaigns more accurately at proxy time. The rule should be:
  • One concrete sentence describing the pattern (e.g. a lever class whose proxy result systematically over/under-states the real LTV)
  • Actionable for a grader scoring hypothesis_quality and result_quality 1-10
  • General enough to apply to similar future campaigns

Output JSON:
{
  "title": "<3-7 word title>",
  "content": "<the rule itself, 1-3 sentences>"
}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: OPUS_MODEL, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) return;
  const data = await res.json();
  const text = (data.content?.[0] as { text?: string })?.text?.trim() || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return;
  const parsed = JSON.parse(m[0]) as { title?: string; content?: string };
  if (!parsed.title || !parsed.content) return;
  await admin.from("storefront_grader_prompts").insert({
    workspace_id: opts.workspaceId,
    title: parsed.title,
    content: parsed.content,
    status: "proposed",
    derived_from_experiment_id: opts.experimentId,
    derived_from_grade_id: opts.gradeId,
  });
}

// ── Box-hosted grading (grading-cascade-to-box-sessions Phase 4) ────────────────

/**
 * One ungraded (or pending-revised) campaign the box grader will inspect. Discriminated on `mode`.
 * The `experiment_id` keys back to storefront_experiments; the box session pulls the variants,
 * lever posterior, and (for revised mode) cohort reconciliation from the DB itself.
 */
export interface CampaignGradeCandidate {
  experiment_id: string;
  mode: GradeMode;
}

/**
 * Pick the batch of ungraded / pending-revised campaigns for the box-hosted grader. Mirrors
 * [[director-grader]] `pickDirectorGradeBatch` — the caller enqueues ONE `campaign-grade`
 * `agent_jobs` row per batch-ready workspace with `instructions.candidates = [...]`; the box lane
 * (scripts/builder-worker.ts → runCampaignGradeJob) grades each candidate and writes
 * storefront_campaign_grades via `applyBoxCampaignGrade` (same UNIQUE(experiment_id) upsert +
 * `graded_by='human'` override invariant as the API path). A no-op (empty array) while nothing is
 * ungraded / awaiting-revision. Best-effort.
 *
 * Selection: (1) INITIAL — concluded campaigns (status ∈ promoted｜killed｜rolled_back) with no
 * grade row yet, then (2) REVISED — campaigns with a grade_initial but no grade_revised whose
 * cohort has now reconciled. Truncated to `cap`; the rest ride the next beat.
 */
export async function pickCampaignGradeBatch(opts: {
  workspaceId: string;
  admin?: Admin;
  cap?: number;
}): Promise<CampaignGradeCandidate[]> {
  const admin = opts.admin ?? createAdminClient();
  const cap = opts.cap ?? CAMPAIGN_GRADE_BATCH_CAP;
  const out: CampaignGradeCandidate[] = [];

  try {
    // ── Existing-grade set — paginated past the 1000-row PostgREST cap. ──
    interface GradeRow { experiment_id: string; grade_initial: number | null; grade_revised: number | null; graded_by: string }
    const graded = new Map<string, GradeRow>();
    for (let from = 0; ; from += 1000) {
      const { data } = await admin
        .from("storefront_campaign_grades")
        .select("experiment_id, grade_initial, grade_revised, graded_by")
        .eq("workspace_id", opts.workspaceId)
        .range(from, from + 999);
      const rows = (data as GradeRow[]) || [];
      for (const r of rows) graded.set(r.experiment_id, r);
      if (rows.length < 1000) break;
    }

    // ── INITIAL candidates — concluded campaigns with no grade row yet. ──
    const { data: expData } = await admin
      .from("storefront_experiments")
      .select("id, workspace_id, product_id, lander_type, audience, status")
      .eq("workspace_id", opts.workspaceId)
      .in("status", ["promoted", "killed", "rolled_back"])
      .order("stopped_at", { ascending: false, nullsFirst: false })
      .limit(500);
    interface ExpLite { id: string; workspace_id: string; product_id: string; lander_type: string; audience: string; status: string }
    const experiments = (expData as ExpLite[]) || [];

    for (const e of experiments) {
      if (out.length >= cap) break;
      const g = graded.get(e.id);
      if (g && g.grade_initial != null) continue; // already initial-graded (revised handled below)
      // A human-graded row with grade_initial null (initial override cleared) is odd but respect it —
      // never re-emit the initial candidate.
      if (g && g.graded_by === "human") continue;
      out.push({ experiment_id: e.id, mode: "initial" });
    }

    // ── REVISED candidates — grade_initial present, grade_revised null, cohort now reconciled. ──
    if (out.length < cap) {
      const pendingRevised: string[] = [];
      for (const [expId, g] of graded) {
        if (g.grade_initial != null && g.grade_revised == null && g.graded_by !== "human") pendingRevised.push(expId);
      }
      if (pendingRevised.length) {
        // Resolve (product_id, lander_type, audience) per experiment to check reconciliation existence.
        const { data: expForRevised } = await admin
          .from("storefront_experiments")
          .select("id, workspace_id, product_id, lander_type, audience")
          .in("id", pendingRevised);
        const expByIdLocal = new Map<string, ExpLite>();
        for (const e of (expForRevised as ExpLite[]) || []) expByIdLocal.set(e.id, e);

        for (const expId of pendingRevised) {
          if (out.length >= cap) break;
          const e = expByIdLocal.get(expId);
          if (!e) continue;
          const { data: rec } = await admin
            .from("storefront_ltv_reconciliations")
            .select("id")
            .eq("workspace_id", e.workspace_id)
            .eq("product_id", e.product_id)
            .eq("lander_type", e.lander_type)
            .eq("audience", e.audience)
            .limit(1);
          if (!rec || !rec.length) continue; // cohort not reconciled yet — revision pass no-ops anyway
          out.push({ experiment_id: expId, mode: "revised" });
        }
      }
    }
  } catch (e) {
    console.warn(`[campaign-grader] pickCampaignGradeBatch failed ws=${opts.workspaceId}: ${errText(e)}`);
  }
  return out;
}

interface ExistingCampaignGradeRow {
  id: string;
  grade_initial: number | null;
  grade_revised: number | null;
  graded_by: string;
}

/**
 * Apply a campaign grade produced by the box-hosted grading session
 * (grading-cascade-to-box-sessions Phase 4) — a Max `claude -p` that reads the concluded campaign's
 * REAL rollups + variants + (revised-mode) reconciliation from the DB and grades from concrete
 * evidence. Reuses the same UNIQUE(experiment_id) upsert + `graded_by='human'` override invariant
 * as the deployed gradeCampaign path — the training signal (loadLeverGradeSignal) fires identically
 * off box-written grades. `model` is stamped `box-max-session`; no `ai_token_usage` write (Max sub
 * has no per-token API bill — the CEO directive was $0 marginal grading).
 *
 * A large initial-vs-revised gap (≥ REVISED_GAP_RULE_THRESHOLD) proposes a `storefront_grader_prompts`
 * calibration rule. The Opus-based proposal call is preserved here — the box session emits an
 * observed gap, this helper drafts the rule with an LLM call ONLY when a real gap is present. The
 * Opus proposal call may be retired in a follow-on once the box session itself carries the drafted
 * title/content, but keeping it here means the caller doesn't need Opus availability.
 */
export async function applyBoxCampaignGrade(opts: {
  workspaceId: string;
  experimentId: string;
  mode: GradeMode;
  grade: number;
  hypothesisQuality?: number;
  resultQuality?: number;
  reasoning: string;
  admin?: Admin;
}): Promise<CampaignGradeResult> {
  const admin = opts.admin ?? createAdminClient();
  const mode = opts.mode;

  const { data: exp } = await admin
    .from("storefront_experiments")
    .select("id, workspace_id, lever, status")
    .eq("id", opts.experimentId)
    .maybeSingle();
  if (!exp) return { ok: false, reason: "experiment_not_found" };
  const experiment = exp as { id: string; workspace_id: string; lever: string; status: string };
  if (!["promoted", "killed", "rolled_back"].includes(experiment.status)) {
    // A benign TOCTOU: the campaign concluded when the box picked it but has since been re-opened.
    return { ok: false, reason: "not_concluded" };
  }

  const { data: existing } = await admin
    .from("storefront_campaign_grades")
    .select("id, grade_initial, grade_revised, graded_by")
    .eq("experiment_id", experiment.id)
    .maybeSingle();
  const existingRow = (existing as ExistingCampaignGradeRow) ?? null;

  const grade = clampGrade(opts.grade);
  const hypothesisQuality = opts.hypothesisQuality != null ? clampGrade(opts.hypothesisQuality) : grade;
  const resultQuality = opts.resultQuality != null ? clampGrade(opts.resultQuality) : grade;
  const now = new Date().toISOString();

  if (mode === "initial") {
    if (existingRow && existingRow.graded_by === "human") {
      return { ok: true, grade_id: existingRow.id, mode, grade: existingRow.grade_initial ?? grade, idempotent_update: true };
    }
    const payload = {
      workspace_id: experiment.workspace_id,
      experiment_id: experiment.id,
      grade_initial: grade,
      grade_initial_reasoning: opts.reasoning,
      hypothesis_quality: hypothesisQuality,
      result_quality: resultQuality,
      initial_graded_at: now,
      graded_by: "agent" as const,
      model: BOX_CAMPAIGN_GRADE_MODEL,
      input_tokens: 0,
      output_tokens: 0,
      cost_cents: 0,
      updated_at: now,
    };
    let gradeId = existingRow?.id;
    if (existingRow) {
      await admin.from("storefront_campaign_grades").update(payload).eq("id", existingRow.id);
    } else {
      const { data: ins, error } = await admin.from("storefront_campaign_grades").insert(payload).select("id").single();
      if (error) return { ok: false, reason: error.message };
      gradeId = ins?.id;
    }
    return { ok: true, grade_id: gradeId, mode, grade, hypothesis_quality: hypothesisQuality, result_quality: resultQuality, idempotent_update: !!existingRow };
  }

  // mode === "revised"
  if (!existingRow?.grade_initial) return { ok: false, reason: "no_initial_grade_yet" };
  if (existingRow.grade_revised != null) return { ok: true, grade_id: existingRow.id, mode, grade: existingRow.grade_revised, idempotent_update: true };
  if (existingRow.graded_by === "human") return { ok: true, grade_id: existingRow.id, mode, grade: existingRow.grade_revised ?? grade, idempotent_update: true };

  await admin
    .from("storefront_campaign_grades")
    .update({
      grade_revised: grade,
      grade_revised_reasoning: opts.reasoning,
      revised_graded_at: now,
      updated_at: now,
    })
    .eq("id", existingRow.id);

  const initial = existingRow.grade_initial ?? grade;
  if (Math.abs(initial - grade) >= REVISED_GAP_RULE_THRESHOLD) {
    await proposeGapCalibrationRule(admin, {
      workspaceId: experiment.workspace_id,
      experimentId: experiment.id,
      gradeId: existingRow.id,
      gradeInitial: initial,
      gradeRevised: grade,
      revisedReasoning: opts.reasoning,
      lever: experiment.lever,
    }).catch((e) => console.warn(`[campaign-grader] gap-rule proposal failed exp=${experiment.id}: ${errText(e)}`));
  }

  return { ok: true, grade_id: existingRow.id, mode, grade, hypothesis_quality: hypothesisQuality, result_quality: resultQuality };
}

/**
 * Revised-grading sweep (called from the M3 reconciler's daily run): for every campaign that has
 * an initial grade but no revised grade and whose cohort has now reconciled, land the revised
 * grade. Best-effort + idempotent (gradeCampaign skips already-revised + unreconciled cohorts).
 */
export async function gradeRevisedForReconciledCohorts(opts: {
  workspaceId: string;
  admin?: Admin;
}): Promise<{ considered: number; revised: number }> {
  const admin = opts.admin ?? createAdminClient();
  let considered = 0;
  let revised = 0;
  try {
    const { data } = await admin
      .from("storefront_campaign_grades")
      .select("experiment_id")
      .eq("workspace_id", opts.workspaceId)
      .not("grade_initial", "is", null)
      .is("grade_revised", null)
      .limit(200);
    for (const row of (data as Array<{ experiment_id: string }>) || []) {
      considered++;
      const r = await gradeCampaign({ experimentId: row.experiment_id, mode: "revised", admin });
      if (r.ok && !r.idempotent_update && r.mode === "revised") revised++;
    }
  } catch (e) {
    console.warn(`[campaign-grader] revised sweep failed ws=${opts.workspaceId}: ${errText(e)}`);
  }
  return { considered, revised };
}

// ── Training signal — expose grades back to M4 (and M2) ───────────────────────

export interface LeverGradeSignal {
  /** avg of (revised ?? initial) grade per lever_key — the headline training bias. */
  avgByLever: Record<string, number>;
  /** avg hypothesis_quality per lever_key (what the agent should chase: sound bets). */
  avgHypothesisByLever: Record<string, number>;
  /** graded campaign count per lever_key. */
  countByLever: Record<string, number>;
  /** Overall average grade across all graded campaigns (the supervised-metric trend anchor). */
  overallAvg: number | null;
  graded: number;
}

/**
 * Load the campaign-grade training signal for a surface: per-lever average grades + hypothesis
 * quality, so the M4 agent biases toward HIGH-GRADED HYPOTHESIS PATTERNS on its next bet (and so
 * M2's lever selector can take it as a secondary weight). The revised grade supersedes the
 * initial one for a campaign once it lands (reality beats proxy). Best-effort (empty if absent).
 */
export async function loadLeverGradeSignal(opts: {
  workspaceId: string;
  productId?: string;
  landerType?: string;
  audience?: string;
  admin?: Admin;
}): Promise<LeverGradeSignal> {
  const admin = opts.admin ?? createAdminClient();
  const empty: LeverGradeSignal = { avgByLever: {}, avgHypothesisByLever: {}, countByLever: {}, overallAvg: null, graded: 0 };
  try {
    const { data: grades } = await admin
      .from("storefront_campaign_grades")
      .select("experiment_id, grade_initial, grade_revised, hypothesis_quality")
      .eq("workspace_id", opts.workspaceId)
      .not("grade_initial", "is", null)
      .limit(500);
    const rows = (grades as Array<{ experiment_id: string; grade_initial: number | null; grade_revised: number | null; hypothesis_quality: number | null }>) || [];
    if (!rows.length) return empty;

    // Resolve each campaign's lever (+ scope filter to the surface when requested).
    const expIds = rows.map((r) => r.experiment_id);
    let q = admin.from("storefront_experiments").select("id, lever, product_id, lander_type, audience").in("id", expIds);
    if (opts.productId) q = q.eq("product_id", opts.productId);
    if (opts.landerType) q = q.eq("lander_type", opts.landerType);
    if (opts.audience) q = q.eq("audience", opts.audience);
    const { data: exps } = await q;
    const leverByExp = new Map(((exps as Array<{ id: string; lever: string }>) || []).map((e) => [e.id, e.lever]));

    const gradeSum = new Map<string, number>();
    const hypSum = new Map<string, number>();
    const count = new Map<string, number>();
    let overallSum = 0;
    let overallN = 0;
    for (const r of rows) {
      const lever = leverByExp.get(r.experiment_id);
      if (!lever) continue; // filtered out of scope
      const grade = r.grade_revised ?? r.grade_initial!;
      gradeSum.set(lever, (gradeSum.get(lever) ?? 0) + grade);
      hypSum.set(lever, (hypSum.get(lever) ?? 0) + (r.hypothesis_quality ?? grade));
      count.set(lever, (count.get(lever) ?? 0) + 1);
      overallSum += grade;
      overallN++;
    }
    if (overallN === 0) return empty;

    const avgByLever: Record<string, number> = {};
    const avgHypothesisByLever: Record<string, number> = {};
    const countByLever: Record<string, number> = {};
    for (const [lever, n] of count) {
      avgByLever[lever] = Math.round((gradeSum.get(lever)! / n) * 100) / 100;
      avgHypothesisByLever[lever] = Math.round((hypSum.get(lever)! / n) * 100) / 100;
      countByLever[lever] = n;
    }
    return { avgByLever, avgHypothesisByLever, countByLever, overallAvg: Math.round((overallSum / overallN) * 100) / 100, graded: overallN };
  } catch {
    return empty;
  }
}
