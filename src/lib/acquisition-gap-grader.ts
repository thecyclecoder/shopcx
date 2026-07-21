/**
 * Acquisition gap grader — the Growth-director feedback signal that trains the scouts (M5 of the
 * Acquisition Research Engine, docs/brain/specs/acquisition-research-loop-grading.md, Phase 1).
 *
 * Closes the CEO → Growth → Scouts chain for the acquisition-research goal: an AI grader scores each
 * surfaced gap (ad or lander) → its outcome 1–10 against a rubric + human-approved calibration rules
 * (the acquisition_grader_prompts store), exactly mirroring the shipped storefront campaign grader
 * (src/lib/storefront/campaign-grader.ts) and the 1–10 ticket grader. The grade is the FEEDBACK
 * SIGNAL of the scouts: loadGapTypeGradeSignal + loadSuppressedGapTypes feed a per-gap_type bias so a
 * low-value/rejected gap type gets DOWN-WEIGHTED over time (suppressed from re-surfacing) instead of
 * being endlessly re-proposed.
 *
 * The defining invariant (inherited from the campaign grader): GAP_QUALITY is scored SEPARATELY from
 * OUTCOME. Was the gap REAL and worth surfacing (independent-brand evidence, the owner approved it)?
 * A sound gap whose experiment lost still scores high on gap_quality; a flimsy gap the owner rejected
 * scores low regardless. The grader must not reward outcome luck.
 *
 * Two grades per gap, BOTH KEPT:
 *   • initial  — when the gap is acted-on (approved | rejected), on what's known then.
 *   • revised  — once the routed action's outcome resolves (the experiment won or lost): did the gap
 *                pay off? A large initial-vs-revised gap proposes an acquisition_grader_prompts rule.
 *
 * The grader is a SUPERVISED TOOL (docs/brain/operational-rules.md § North star): it scores a bounded
 * proxy (gap quality); the Growth director owns the objective and overrides it — overrides are
 * recorded (graded_by='human'/overridden_by), never silently lost.
 *
 * Idempotent per (gap × mode): a re-run UPDATEs the grade row in place, never duplicates.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { logAiUsage, usageCostCents } from "@/lib/ai-usage";
import { SONNET_MODEL, OPUS_MODEL } from "@/lib/ai-models";

type Admin = ReturnType<typeof createAdminClient>;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GRADER_MODEL = SONNET_MODEL;
/** The `model` stamp for a grade produced by the box-hosted grader (Max session — no API bill).
 *  Mirrors [[agent-grader]] BOX_GRADE_MODEL and [[campaign-grader]] BOX_CAMPAIGN_GRADE_MODEL so a
 *  box-vs-API split stays queryable in dashboards. grading-cascade-to-box-sessions Phase 4. */
const BOX_GAP_GRADE_MODEL = "box-max-session";

/** A large initial-vs-revised grade gap at/above this magnitude proposes a calibration rule. */
export const REVISED_GAP_RULE_THRESHOLD = 3;

/** Cap on how many gaps one batched box grading session grades. Mirrors DIRECTOR_GRADE_BATCH_CAP —
 *  each candidate needs a small DB read + a Sonnet-sized grade turn. */
const GAP_GRADE_BATCH_CAP = 8;

/** A gap_type is SUPPRESSED from re-surfacing once its avg grade falls at/below this … */
export const SUPPRESS_GRADE_THRESHOLD = 4;
/** … with at least this many graded instances (so one bad gap doesn't kill a whole type). */
export const SUPPRESS_MIN_GRADED = 2;

export type GapSource = "ad" | "lander";
export type GradeMode = "initial" | "revised";
export type OutcomeState = "rejected" | "approved" | "shipped" | "won" | "lost";

export interface GapGradeResult {
  ok: boolean;
  reason?: string;
  grade_id?: string;
  mode?: GradeMode;
  grade?: number;
  gap_quality?: number;
  outcome_quality?: number;
  outcome_state?: OutcomeState;
  idempotent_update?: boolean;
}

interface GraderJson {
  grade: number;
  gap_quality: number;
  outcome_quality: number;
  reasoning: string;
}

interface GapRow {
  id: string;
  workspace_id: string;
  product_id: string | null;
  gap_type: string;
  title: string;
  rationale: string;
  status: string;
  route: string;
  route_result: Record<string, unknown> | null;
  evidence: Record<string, unknown> | null;
}

/** Load one gap row from whichever queue table it lives in. */
async function loadGapRow(admin: Admin, source: GapSource, gapId: string): Promise<GapRow | null> {
  const table = source === "ad" ? "ad_gap_recommendations" : "lander_recommendations";
  const { data } = await admin
    .from(table)
    .select("id, workspace_id, product_id, gap_type, title, rationale, status, route, route_result, evidence")
    .eq("id", gapId)
    .maybeSingle();
  return (data as GapRow) ?? null;
}

interface OutcomeContext {
  state: OutcomeState | null; // null ⇒ not acted-on yet (proposed) — not gradeable
  detail: string;
}

/**
 * Derive the gap's outcome state from its route artifact (the same join the hub's throughput uses):
 * a rejected gap is terminal; an approved gap's outcome follows its agent_jobs / storefront_experiments
 * artifact (completed build → shipped; promoted experiment → won; killed/rolled-back → lost).
 */
async function deriveOutcome(admin: Admin, gap: GapRow): Promise<OutcomeContext> {
  if (gap.status === "rejected") return { state: "rejected", detail: "the owner rejected this gap" };
  if (gap.status !== "approved") return { state: null, detail: "not acted-on yet" };

  const rr = gap.route_result || {};
  const expId = typeof rr.experiment_id === "string" ? rr.experiment_id : null;
  const jobId = typeof rr.agent_job_id === "string" ? rr.agent_job_id : null;

  if (expId) {
    const { data } = await admin.from("storefront_experiments").select("status").eq("id", expId).maybeSingle();
    const st = (data?.status as string) || "draft";
    if (st === "promoted") return { state: "won", detail: "the routed experiment was promoted (a validated win)" };
    if (["killed", "rolled_back"].includes(st)) return { state: "lost", detail: `the routed experiment was ${st}` };
    if (st !== "draft") return { state: "shipped", detail: `the routed experiment is live (status=${st})` };
    return { state: "approved", detail: "routed to an experiment still in draft" };
  }
  if (jobId) {
    const { data } = await admin.from("agent_jobs").select("status").eq("id", jobId).maybeSingle();
    const st = (data?.status as string) || "queued";
    if (st === "completed") return { state: "shipped", detail: "the routed Build job completed (a PR landed)" };
    return { state: "approved", detail: `routed to a Build job (status=${st})` };
  }
  return { state: "approved", detail: "approved but not yet routed to an artifact" };
}

/**
 * Build the grader system prompt: the static rubric + any APPROVED acquisition_grader_prompts
 * calibration rules. Mode-specific framing (acted-on time vs outcome-resolved time).
 */
export async function buildGapGraderSystemPrompt(admin: Admin, workspaceId: string, mode: GradeMode): Promise<string> {
  const { data: rules } = await admin
    .from("acquisition_grader_prompts")
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
      ? `You are grading the moment the gap was ACTED-ON — the owner either approved it (and it routed to a Build / an experiment) or rejected it. The final outcome may not be known yet, so grade OUTCOME on what is known now.`
      : `You are RE-GRADING the same gap now that its routed action's OUTCOME has resolved (the experiment won or lost / the build shipped). Judge whether the gap PAID OFF: a gap the owner approved that then lost should see outcome_quality fall; one that won should rise. The GAP quality rarely changes on revision — the gap was real or flimsy when surfaced regardless of how the experiment landed.`;

  return `You are the Head of Growth grading the competitive GAPS surfaced by two autonomous scouts (an Ad Creative Scout and a Landing Page Scout) for the acquisition-research engine. Each gap is ONE proposal: "competitors do X (an ad angle / a lander section) that we don't — test it." The owner approved it (→ a Build / a storefront experiment) or rejected it.

${modeBlock}

THE DEFINING RULE — GRADE GAP QUALITY SEPARATELY FROM OUTCOME:
  • gap_quality (1-10): was the gap REAL and worth surfacing at proposal time? Was it backed by strong, INDEPENDENT-brand evidence (multiple competitors, longevity, spend / multiple competitor landers), specific and actionable, and not a duplicate of something we already run? A well-evidenced gap whose experiment LOST is still GOOD SCOUTING → score gap_quality HIGH. A flimsy, thin-evidence gap the owner rejected → score gap_quality LOW regardless of any outcome.
  • outcome_quality (1-10): how did the resulting ACTION perform? Rejected by the owner = the gap did not earn action (low). Approved + shipped but unresolved = provisional/middling. The routed experiment WON (promoted) = high. It LOST (killed/rolled-back) = low. Account for how decisively, not just the binary.
  • grade (1-10): the overall grade. Weight gap_quality at least as heavily as outcome — we are training scouts to surface SOUND, well-evidenced gaps, not to get lucky. Do NOT reward outcome luck; do NOT punish a well-scouted gap that lost.

SCORING (1-10), each axis:
  10 — exemplary. 8-9 — strong. 6-7 — acceptable. 4-5 — mediocre. 2-3 — poor. 1 — indefensible.

HARD RULES:
  • A well-evidenced gap (many independent competitor brands / landers, long-running, high spend) that the owner approved earns a HIGH gap_quality even if the experiment later LOST (sound scouting).
  • A gap the owner REJECTED earns a LOW gap_quality — the scout surfaced something not worth the owner's time.
  • Thin evidence (a single brand, no longevity/spend signal) caps gap_quality at 5 — an under-evidenced "gap" is a guess, not a finding.${rulesBlock}

OUTPUT (JSON only, no prose around it):
{
  "grade": <integer 1-10>,
  "gap_quality": <integer 1-10>,
  "outcome_quality": <integer 1-10>,
  "reasoning": "<2-4 sentences: why the gap was sound or flimsy, and how its outcome reads — kept distinct>"
}`;
}

/** A compact, gradeable description of the gap + its outcome. */
function formatGapForGrading(gap: GapRow, source: GapSource, outcome: OutcomeContext): string {
  const ev = gap.evidence || {};
  const evidenceBits: string[] = [];
  if (source === "ad") {
    if (typeof ev.brandCount === "number") evidenceBits.push(`independent competitor brands: ${ev.brandCount}`);
    if (Array.isArray(ev.brands)) evidenceBits.push(`brands: ${(ev.brands as string[]).slice(0, 6).join(", ")}`);
    if (typeof ev.maxDaysRunning === "number") evidenceBits.push(`max days running: ${ev.maxDaysRunning}`);
    if (typeof ev.totalEstimatedSpend === "number") evidenceBits.push(`total est. spend: $${ev.totalEstimatedSpend}`);
    if (Array.isArray(ev.offers) && (ev.offers as string[]).length) evidenceBits.push(`offers: ${(ev.offers as string[]).join(", ")}`);
  } else {
    if (typeof ev.competitor_count === "number") evidenceBits.push(`competitor landers showing this: ${ev.competitor_count}`);
    if (Array.isArray(ev.competitor_snapshot_ids)) evidenceBits.push(`backing snapshots: ${(ev.competitor_snapshot_ids as string[]).length}`);
  }

  return [
    `GAP — ${source} gap ${gap.id}`,
    `  type: ${gap.gap_type} · route: ${gap.route}`,
    `  title: ${gap.title}`,
    `  rationale (the scout's evidence sentence): ${gap.rationale}`,
    `  supporting evidence: ${evidenceBits.length ? evidenceBits.join(" · ") : "(none recorded)"}`,
    ``,
    `  OWNER DECISION: ${gap.status}`,
    `  OUTCOME: ${outcome.state} — ${outcome.detail}`,
  ].join("\n");
}

async function runGrader(
  system: string,
  userMsg: string,
  workspaceId: string,
): Promise<{ json: GraderJson; costCents: number; usage: unknown } | { error: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: GRADER_MODEL, max_tokens: 1000, system, messages: [{ role: "user", content: userMsg }] }),
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
  await logAiUsage({ workspaceId, model: GRADER_MODEL, usage, purpose: "acquisition_gap_grading" });

  let parsed: GraderJson | null = null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]) as GraderJson;
  } catch {
    /* fall through */
  }
  const valid =
    parsed &&
    [parsed.grade, parsed.gap_quality, parsed.outcome_quality].every((n) => typeof n === "number" && n >= 1 && n <= 10);
  if (!valid) return { error: "parse_failed" };
  return { json: parsed as GraderJson, costCents, usage };
}

function clampGrade(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)));
}

interface ExistingGradeRow {
  id: string;
  grade_initial: number | null;
  grade_revised: number | null;
  outcome_state: OutcomeState;
  graded_by: string;
}

/**
 * Grade ONE acted-on gap, in `initial` or `revised` mode. Idempotent per (gap × mode): the row is
 * keyed on (workspace_id, gap_source, gap_id); an initial re-grade updates the initial columns in
 * place, a revised grade fills the revised columns WITHOUT touching the initial ones (both persist).
 * Never clobbers a human override.
 */
export async function gradeGap(opts: {
  source: GapSource;
  gapId: string;
  mode: GradeMode;
  admin?: Admin;
}): Promise<GapGradeResult> {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: "no_api_key" };
  const admin = opts.admin ?? createAdminClient();
  const mode = opts.mode;

  const gap = await loadGapRow(admin, opts.source, opts.gapId);
  if (!gap) return { ok: false, reason: "gap_not_found" };

  const outcome = await deriveOutcome(admin, gap);
  if (!outcome.state) return { ok: false, reason: "gap_not_acted_on" };

  const { data: existing } = await admin
    .from("acquisition_gap_grades")
    .select("id, grade_initial, grade_revised, outcome_state, graded_by")
    .eq("workspace_id", gap.workspace_id)
    .eq("gap_source", opts.source)
    .eq("gap_id", gap.id)
    .maybeSingle();
  const existingRow = existing as ExistingGradeRow | null;

  if (mode === "revised") {
    if (!existingRow?.grade_initial) return { ok: false, reason: "no_initial_grade_yet" };
    if (existingRow.grade_revised != null)
      return { ok: true, grade_id: existingRow.id, mode, grade: existingRow.grade_revised, idempotent_update: true };
    // Only revise once the outcome has actually RESOLVED (won/lost).
    if (outcome.state !== "won" && outcome.state !== "lost") return { ok: false, reason: "outcome_not_resolved" };
  }

  const system = await buildGapGraderSystemPrompt(admin, gap.workspace_id, mode);
  const userMsg = `Grade this competitive gap. Return the JSON only.\n\n${formatGapForGrading(gap, opts.source, outcome)}`;

  const graded = await runGrader(system, userMsg, gap.workspace_id);
  if ("error" in graded) return { ok: false, reason: graded.error };
  const g = graded.json;
  const grade = clampGrade(g.grade);
  const gapQuality = clampGrade(g.gap_quality);
  const outcomeQuality = clampGrade(g.outcome_quality);
  const now = new Date().toISOString();

  if (mode === "initial") {
    if (existingRow && existingRow.graded_by === "human") {
      return { ok: true, grade_id: existingRow.id, mode, grade: existingRow.grade_initial ?? grade, idempotent_update: true };
    }
    const payload = {
      workspace_id: gap.workspace_id,
      gap_source: opts.source,
      gap_id: gap.id,
      product_id: gap.product_id,
      gap_type: gap.gap_type,
      grade_initial: grade,
      grade_initial_reasoning: g.reasoning,
      gap_quality: gapQuality,
      outcome_quality: outcomeQuality,
      outcome_state: outcome.state,
      initial_graded_at: now,
      graded_by: "agent" as const,
      model: GRADER_MODEL,
      input_tokens: (graded.usage as { input_tokens?: number } | undefined)?.input_tokens || 0,
      output_tokens: (graded.usage as { output_tokens?: number } | undefined)?.output_tokens || 0,
      cost_cents: graded.costCents,
      updated_at: now,
    };
    let gradeId = existingRow?.id;
    if (existingRow) {
      await admin.from("acquisition_gap_grades").update(payload).eq("id", existingRow.id);
    } else {
      const { data: ins } = await admin.from("acquisition_gap_grades").insert(payload).select("id").single();
      gradeId = ins?.id;
    }
    return { ok: true, grade_id: gradeId, mode, grade, gap_quality: gapQuality, outcome_quality: outcomeQuality, outcome_state: outcome.state, idempotent_update: !!existingRow };
  }

  // revised — fill the revised columns + record the resolved outcome; leave the initial grade untouched.
  await admin
    .from("acquisition_gap_grades")
    .update({
      grade_revised: grade,
      grade_revised_reasoning: g.reasoning,
      outcome_state: outcome.state,
      revised_graded_at: now,
      updated_at: now,
    })
    .eq("id", existingRow!.id);

  const initial = existingRow!.grade_initial ?? grade;
  if (Math.abs(initial - grade) >= REVISED_GAP_RULE_THRESHOLD) {
    await proposeGapCalibrationRule(admin, {
      workspaceId: gap.workspace_id,
      source: opts.source,
      gapId: gap.id,
      gradeId: existingRow!.id,
      gradeInitial: initial,
      gradeRevised: grade,
      revisedReasoning: g.reasoning,
      gapType: gap.gap_type,
    }).catch((e) => console.warn(`[acquisition-gap-grader] gap-rule proposal failed gap=${gap.id}: ${errText(e)}`));
  }

  return { ok: true, grade_id: existingRow!.id, mode, grade, gap_quality: gapQuality, outcome_quality: outcomeQuality, outcome_state: outcome.state };
}

/**
 * A large initial-vs-revised gap means the rubric mis-judged the gap at acted-on time — draft a
 * calibration rule (Opus) the Growth director can approve. Inserted 'proposed' + provenance.
 */
async function proposeGapCalibrationRule(
  admin: Admin,
  opts: {
    workspaceId: string;
    source: GapSource;
    gapId: string;
    gradeId: string;
    gradeInitial: number;
    gradeRevised: number;
    revisedReasoning: string;
    gapType: string;
  },
): Promise<void> {
  if (!ANTHROPIC_API_KEY) return;
  const prompt = `An acquisition-research scout surfaced a "${opts.gapType}" competitive gap. When it was acted-on the gap grader gave an INITIAL grade of ${opts.gradeInitial}/10. Once the routed action's outcome resolved, the REVISED grade was ${opts.gradeRevised}/10. The revised reasoning: "${opts.revisedReasoning}"

This is a large gap, which means the grader's rubric likely mis-weighted something at acted-on time. Propose a SHORT calibration rule to add to the gap grader's system prompt so it judges similar future gaps more accurately. The rule should be:
  • One concrete sentence describing the pattern (e.g. a gap_type whose evidence systematically over/under-states real conversion value)
  • Actionable for a grader scoring gap_quality and outcome_quality 1-10 (gap quality is judged SEPARATELY from outcome — a well-evidenced gap that lost is still good scouting)
  • General enough to apply to similar future gaps

Output JSON:
{
  "title": "<3-7 word title>",
  "content": "<the rule itself, 1-3 sentences>"
}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: OPUS_MODEL, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) return;
  const data = await res.json();
  const text = (data.content?.[0] as { text?: string })?.text?.trim() || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return;
  const parsed = JSON.parse(m[0]) as { title?: string; content?: string };
  if (!parsed.title || !parsed.content) return;
  await admin.from("acquisition_grader_prompts").insert({
    workspace_id: opts.workspaceId,
    title: parsed.title,
    content: parsed.content,
    status: "proposed",
    derived_from_gap_source: opts.source,
    derived_from_gap_id: opts.gapId,
    derived_from_grade_id: opts.gradeId,
  });
}

// ── Box-hosted grading (grading-cascade-to-box-sessions Phase 4) ────────────────

/** One ungraded / pending-revised gap the box grader will inspect. Discriminated on `mode`. */
export interface GapGradeCandidate {
  source: GapSource;
  gap_id: string;
  mode: GradeMode;
}

/**
 * Pick the batch of ungraded / pending-revised gaps for the box-hosted grader. Mirrors
 * [[campaign-grader]] `pickCampaignGradeBatch` — the caller enqueues ONE `gap-grade` `agent_jobs`
 * row per batch-ready workspace with `instructions.candidates = [...]`; the box lane
 * (scripts/builder-worker.ts → runGapGradeJob) grades each candidate and writes acquisition_gap_grades
 * via `applyBoxGapGrade` (same UNIQUE(workspace_id, gap_source, gap_id) upsert + `graded_by='human'`
 * override invariant). Best-effort — a no-op (empty array) while nothing is ungraded / awaiting-revision.
 *
 * Selection: (1) INITIAL — every acted-on gap (status ∈ approved｜rejected) that has no grade row
 * yet, then (2) REVISED — every graded gap whose routed outcome has since resolved (won｜lost) and
 * whose grade_revised is still null. Truncated to `cap`; the rest ride the next beat.
 */
export async function pickGapGradeBatch(opts: {
  workspaceId: string;
  admin?: Admin;
  cap?: number;
}): Promise<GapGradeCandidate[]> {
  const admin = opts.admin ?? createAdminClient();
  const cap = opts.cap ?? GAP_GRADE_BATCH_CAP;
  const out: GapGradeCandidate[] = [];

  try {
    // ── Existing-grade set — paginated past the 1000-row PostgREST cap. ──
    interface GradeRow { gap_source: string; gap_id: string; grade_initial: number | null; grade_revised: number | null; graded_by: string }
    const graded = new Map<string, GradeRow>();
    for (let from = 0; ; from += 1000) {
      const { data } = await admin
        .from("acquisition_gap_grades")
        .select("gap_source, gap_id, grade_initial, grade_revised, graded_by")
        .eq("workspace_id", opts.workspaceId)
        .range(from, from + 999);
      const rows = (data as GradeRow[]) || [];
      for (const r of rows) graded.set(`${r.gap_source}:${r.gap_id}`, r);
      if (rows.length < 1000) break;
    }

    // ── INITIAL candidates — acted-on gaps with no grade row yet. ──
    const candidates: Array<{ source: GapSource; id: string }> = [];
    for (const source of ["ad", "lander"] as GapSource[]) {
      const table = source === "ad" ? "ad_gap_recommendations" : "lander_recommendations";
      const { data } = await admin
        .from(table)
        .select("id")
        .eq("workspace_id", opts.workspaceId)
        .in("status", ["approved", "rejected"])
        .order("created_at", { ascending: false })
        .limit(500);
      for (const r of (data as Array<{ id: string }>) || []) candidates.push({ source, id: r.id });
    }

    for (const c of candidates) {
      if (out.length >= cap) break;
      const key = `${c.source}:${c.id}`;
      const g = graded.get(key);
      if (g && g.grade_initial != null) continue; // already initial-graded
      if (g && g.graded_by === "human") continue; // human ownership — never re-emit
      out.push({ source: c.source, gap_id: c.id, mode: "initial" });
    }

    // ── REVISED candidates — grade_initial present, grade_revised null, outcome must have resolved. ──
    // The applyBoxGapGrade + deriveOutcome path re-checks won/lost, so we just surface anything that
    // MIGHT be ready. Truncated to `cap`.
    if (out.length < cap) {
      for (const [, g] of graded) {
        if (out.length >= cap) break;
        if (g.grade_initial != null && g.grade_revised == null && g.graded_by !== "human") {
          out.push({ source: g.gap_source as GapSource, gap_id: g.gap_id, mode: "revised" });
        }
      }
    }
  } catch (e) {
    console.warn(`[acquisition-gap-grader] pickGapGradeBatch failed ws=${opts.workspaceId}: ${errText(e)}`);
  }
  return out;
}

interface ExistingGapGradeRow {
  id: string;
  grade_initial: number | null;
  grade_revised: number | null;
  outcome_state: OutcomeState;
  graded_by: string;
}

/**
 * Apply a gap grade produced by the box-hosted grading session
 * (grading-cascade-to-box-sessions Phase 4) — a Max `claude -p` that reads the gap + its routed
 * outcome from the DB and grades from concrete evidence. Reuses the same UNIQUE(workspace_id,
 * gap_source, gap_id) upsert + `graded_by='human'` override invariant as the API path, so the
 * training signal (loadGapTypeGradeSignal + loadSuppressedGapTypes) fires identically off
 * box-written grades. `model` is stamped `box-max-session`; no `ai_token_usage` write (Max sub has
 * no per-token API bill — the CEO directive was $0 marginal grading). A large initial-vs-revised
 * gap proposes an `acquisition_grader_prompts` calibration rule via `proposeGapCalibrationRule`
 * (Opus) — preserved so the calibration arc still fires from box grades.
 */
export async function applyBoxGapGrade(opts: {
  workspaceId: string;
  source: GapSource;
  gapId: string;
  mode: GradeMode;
  grade: number;
  gapQuality?: number;
  outcomeQuality?: number;
  reasoning: string;
  admin?: Admin;
}): Promise<GapGradeResult> {
  const admin = opts.admin ?? createAdminClient();
  const mode = opts.mode;

  const gap = await loadGapRow(admin, opts.source, opts.gapId);
  if (!gap) return { ok: false, reason: "gap_not_found" };

  const outcome = await deriveOutcome(admin, gap);
  if (!outcome.state) return { ok: false, reason: "gap_not_acted_on" };

  const { data: existing } = await admin
    .from("acquisition_gap_grades")
    .select("id, grade_initial, grade_revised, outcome_state, graded_by")
    .eq("workspace_id", opts.workspaceId)
    .eq("gap_source", opts.source)
    .eq("gap_id", opts.gapId)
    .maybeSingle();
  const existingRow = (existing as ExistingGapGradeRow) ?? null;

  const grade = clampGrade(opts.grade);
  const gapQuality = opts.gapQuality != null ? clampGrade(opts.gapQuality) : grade;
  const outcomeQuality = opts.outcomeQuality != null ? clampGrade(opts.outcomeQuality) : grade;
  const now = new Date().toISOString();

  if (mode === "initial") {
    if (existingRow && existingRow.graded_by === "human") {
      return { ok: true, grade_id: existingRow.id, mode, grade: existingRow.grade_initial ?? grade, idempotent_update: true };
    }
    const payload = {
      workspace_id: gap.workspace_id,
      gap_source: opts.source,
      gap_id: gap.id,
      product_id: gap.product_id,
      gap_type: gap.gap_type,
      grade_initial: grade,
      grade_initial_reasoning: opts.reasoning,
      gap_quality: gapQuality,
      outcome_quality: outcomeQuality,
      outcome_state: outcome.state,
      initial_graded_at: now,
      graded_by: "agent" as const,
      model: BOX_GAP_GRADE_MODEL,
      input_tokens: 0,
      output_tokens: 0,
      cost_cents: 0,
      updated_at: now,
    };
    let gradeId = existingRow?.id;
    if (existingRow) {
      await admin.from("acquisition_gap_grades").update(payload).eq("id", existingRow.id);
    } else {
      const { data: ins, error } = await admin.from("acquisition_gap_grades").insert(payload).select("id").single();
      if (error) return { ok: false, reason: error.message };
      gradeId = ins?.id;
    }
    return { ok: true, grade_id: gradeId, mode, grade, gap_quality: gapQuality, outcome_quality: outcomeQuality, outcome_state: outcome.state, idempotent_update: !!existingRow };
  }

  // mode === "revised"
  if (!existingRow?.grade_initial) return { ok: false, reason: "no_initial_grade_yet" };
  if (existingRow.grade_revised != null) return { ok: true, grade_id: existingRow.id, mode, grade: existingRow.grade_revised, idempotent_update: true };
  if (existingRow.graded_by === "human") return { ok: true, grade_id: existingRow.id, mode, grade: existingRow.grade_revised ?? grade, idempotent_update: true };
  if (outcome.state !== "won" && outcome.state !== "lost") return { ok: false, reason: "outcome_not_resolved" };

  await admin
    .from("acquisition_gap_grades")
    .update({
      grade_revised: grade,
      grade_revised_reasoning: opts.reasoning,
      outcome_state: outcome.state,
      revised_graded_at: now,
      updated_at: now,
    })
    .eq("id", existingRow.id);

  const initial = existingRow.grade_initial ?? grade;
  if (Math.abs(initial - grade) >= REVISED_GAP_RULE_THRESHOLD) {
    await proposeGapCalibrationRule(admin, {
      workspaceId: gap.workspace_id,
      source: opts.source,
      gapId: gap.id,
      gradeId: existingRow.id,
      gradeInitial: initial,
      gradeRevised: grade,
      revisedReasoning: opts.reasoning,
      gapType: gap.gap_type,
    }).catch((e) => console.warn(`[acquisition-gap-grader] gap-rule proposal failed gap=${gap.id}: ${errText(e)}`));
  }

  return { ok: true, grade_id: existingRow.id, mode, grade, gap_quality: gapQuality, outcome_quality: outcomeQuality, outcome_state: outcome.state };
}

/**
 * The standing-cadence grading sweep (called from the acquisition-research-cadence cron): grade
 * every acted-on gap (approved | rejected) that has no grade yet, and revise-grade every graded gap
 * whose routed outcome has since resolved (won | lost). Best-effort + idempotent.
 */
export async function gradeActedGaps(opts: { workspaceId: string; admin?: Admin }): Promise<{ considered: number; initial: number; revised: number }> {
  const admin = opts.admin ?? createAdminClient();
  let considered = 0;
  let initial = 0;
  let revised = 0;
  try {
    // Candidate acted-on gaps from both queues.
    const candidates: Array<{ source: GapSource; id: string }> = [];
    for (const source of ["ad", "lander"] as GapSource[]) {
      const table = source === "ad" ? "ad_gap_recommendations" : "lander_recommendations";
      const { data } = await admin
        .from(table)
        .select("id")
        .eq("workspace_id", opts.workspaceId)
        .in("status", ["approved", "rejected"])
        .limit(500);
      for (const r of (data as Array<{ id: string }>) || []) candidates.push({ source, id: r.id as string });
    }

    // Existing grades keyed by source:gap_id (so we know what's graded / pending revision).
    const { data: gradeRows } = await admin
      .from("acquisition_gap_grades")
      .select("gap_source, gap_id, grade_initial, grade_revised, graded_by")
      .eq("workspace_id", opts.workspaceId)
      .limit(2000);
    const graded = new Map<string, { grade_initial: number | null; grade_revised: number | null; graded_by: string }>();
    for (const r of (gradeRows as Array<{ gap_source: string; gap_id: string; grade_initial: number | null; grade_revised: number | null; graded_by: string }>) || []) {
      graded.set(`${r.gap_source}:${r.gap_id}`, { grade_initial: r.grade_initial, grade_revised: r.grade_revised, graded_by: r.graded_by });
    }

    for (const c of candidates) {
      considered++;
      const key = `${c.source}:${c.id}`;
      const ex = graded.get(key);
      if (!ex) {
        const r = await gradeGap({ source: c.source, gapId: c.id, mode: "initial", admin });
        if (r.ok && !r.idempotent_update) initial++;
      } else if (ex.grade_initial != null && ex.grade_revised == null) {
        // Try a revised grade — gradeGap no-ops unless the outcome has resolved (won/lost).
        const r = await gradeGap({ source: c.source, gapId: c.id, mode: "revised", admin });
        if (r.ok && !r.idempotent_update && r.mode === "revised") revised++;
      }
    }
  } catch (e) {
    console.warn(`[acquisition-gap-grader] sweep failed ws=${opts.workspaceId}: ${errText(e)}`);
  }
  return { considered, initial, revised };
}

// ── Training signal — expose grades back to the scouts ─────────────────────────

export interface GapTypeGradeSignal {
  /** avg of (revised ?? initial) grade per `${source}:${gap_type}` key — the headline training bias. */
  avgByType: Record<string, number>;
  /** avg gap_quality per key (what the scouts should chase: well-evidenced gaps). */
  avgGapQualityByType: Record<string, number>;
  /** graded count per key. */
  countByType: Record<string, number>;
  /** Overall average grade across all graded gaps (the supervised-metric trend anchor). */
  overallAvg: number | null;
  graded: number;
}

const typeKey = (source: string, gapType: string) => `${source}:${gapType}`;

/**
 * Load the gap-grade training signal for a workspace: per-(source,gap_type) average grade + gap
 * quality, so the scouts bias toward HIGH-GRADED gap types and suppress low-graded ones. The revised
 * grade supersedes the initial one once it lands. Best-effort (empty if absent).
 */
export async function loadGapTypeGradeSignal(opts: { workspaceId: string; admin?: Admin }): Promise<GapTypeGradeSignal> {
  const admin = opts.admin ?? createAdminClient();
  const empty: GapTypeGradeSignal = { avgByType: {}, avgGapQualityByType: {}, countByType: {}, overallAvg: null, graded: 0 };
  try {
    const { data } = await admin
      .from("acquisition_gap_grades")
      .select("gap_source, gap_type, grade_initial, grade_revised, gap_quality")
      .eq("workspace_id", opts.workspaceId)
      .not("grade_initial", "is", null)
      .limit(2000);
    const rows = (data as Array<{ gap_source: string; gap_type: string; grade_initial: number | null; grade_revised: number | null; gap_quality: number | null }>) || [];
    if (!rows.length) return empty;

    const gradeSum = new Map<string, number>();
    const gapQSum = new Map<string, number>();
    const count = new Map<string, number>();
    let overallSum = 0;
    let overallN = 0;
    for (const r of rows) {
      const key = typeKey(r.gap_source, r.gap_type);
      const grade = r.grade_revised ?? r.grade_initial!;
      gradeSum.set(key, (gradeSum.get(key) ?? 0) + grade);
      gapQSum.set(key, (gapQSum.get(key) ?? 0) + (r.gap_quality ?? grade));
      count.set(key, (count.get(key) ?? 0) + 1);
      overallSum += grade;
      overallN++;
    }

    const avgByType: Record<string, number> = {};
    const avgGapQualityByType: Record<string, number> = {};
    const countByType: Record<string, number> = {};
    for (const [key, n] of count) {
      avgByType[key] = Math.round((gradeSum.get(key)! / n) * 100) / 100;
      avgGapQualityByType[key] = Math.round((gapQSum.get(key)! / n) * 100) / 100;
      countByType[key] = n;
    }
    return { avgByType, avgGapQualityByType, countByType, overallAvg: Math.round((overallSum / overallN) * 100) / 100, graded: overallN };
  } catch {
    return empty;
  }
}

/**
 * The scouts' read path for "what NOT to re-surface": gap types whose average grade has fallen to
 * SUPPRESS_GRADE_THRESHOLD or below with at least SUPPRESS_MIN_GRADED graded instances. Returns a Set
 * of `${source}:${gap_type}` keys. This is how the loop LEARNS — a low-value/rejected gap type gets
 * down-weighted over time instead of being endlessly re-proposed. Best-effort (empty if absent).
 */
export async function loadSuppressedGapTypes(opts: { workspaceId: string; admin?: Admin }): Promise<Set<string>> {
  const signal = await loadGapTypeGradeSignal(opts);
  const suppressed = new Set<string>();
  for (const [key, avg] of Object.entries(signal.avgByType)) {
    if ((signal.countByType[key] ?? 0) >= SUPPRESS_MIN_GRADED && avg <= SUPPRESS_GRADE_THRESHOLD) suppressed.add(key);
  }
  return suppressed;
}

/** Convenience: is a given (source, gap_type) currently suppressed? */
export function isSuppressed(suppressed: Set<string>, source: GapSource, gapType: string): boolean {
  return suppressed.has(typeKey(source, gapType));
}
