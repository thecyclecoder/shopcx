/**
 * Daily AI Analysis Report generator.
 *
 * Aggregates a day's ticket_analyses into a written report with:
 *   - Narrative summary (themes, severity, signal)
 *   - Themes (clustered failure modes with ticket IDs)
 *   - Proposed sonnet_prompts (rules for the AI agent)
 *   - Proposed grader_prompts (calibration rules for the analyzer)
 *
 * The proposed rules are inserted into their respective tables with
 * status='proposed' so they show up in the existing approval queues at
 * Settings → AI → Prompts and Settings → AI → Grader Rules. The
 * daily_analysis_reports row stores the IDs so the report UI can show
 * "View proposed rule →" links.
 *
 * Run by cron (6 AM Central, covers yesterday) or on-demand via API.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { logAiUsage, usageCostCents } from "@/lib/ai-usage";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const REPORT_MODEL = "claude-opus-4-7";

interface AnalysisInput {
  ticket_id: string;
  score: number | null;
  admin_score: number | null;
  admin_score_reason: string | null;
  summary: string | null;
  issues: Array<{ type: string; description: string }>;
  action_items: Array<{ priority: string; description: string }>;
}

interface OpusReportOutput {
  summary: string;
  themes: Array<{
    name: string;
    count: number;
    ticket_ids: string[];
    description: string;
    severity?: "high" | "medium" | "low";
  }>;
  recommendations: Array<{ priority: "high" | "medium" | "low"; description: string }>;
  proposed_sonnet_prompts: Array<{ title: string; content: string; category?: string }>;
  proposed_grader_prompts: Array<{ title: string; content: string }>;
}

interface GenerateResult {
  ok: boolean;
  reason?: string;
  reportId?: string;
  analyzed_count?: number;
}

/**
 * Generate (or regenerate) the daily report for a given workspace + date.
 *
 * Date format: YYYY-MM-DD. The window is UTC midnight-to-midnight of that
 * date, matching the per-day rollup in the ticket-analyses API.
 */
export async function generateDailyReport(
  workspaceId: string,
  date: string,
  trigger: "cron" | "manual" | "backfill" = "cron",
  generatedBy: string | null = null,
): Promise<GenerateResult> {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: "no_api_key" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: "bad_date_format" };

  const admin = createAdminClient();

  const dayStart = new Date(date + "T00:00:00.000Z").toISOString();
  const dayEnd = new Date(new Date(date + "T00:00:00.000Z").getTime() + 24 * 60 * 60 * 1000).toISOString();

  const { data: analyses } = await admin.from("ticket_analyses")
    .select("id, ticket_id, score, admin_score, admin_score_reason, summary, issues, action_items, created_at")
    .eq("workspace_id", workspaceId)
    .gte("created_at", dayStart)
    .lt("created_at", dayEnd)
    .order("created_at", { ascending: true });

  if (!analyses?.length) return { ok: false, reason: "no_analyses_for_date" };

  // Stats
  const scores = analyses.map(a => (a.admin_score ?? a.score) as number | null).filter((s): s is number => s != null);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const worst = scores.length ? Math.min(...scores) : null;
  const best = scores.length ? Math.max(...scores) : null;
  const actionItemsCount = analyses.reduce((acc, a) => acc + ((a.action_items as unknown[])?.length || 0), 0);
  const adminCorrected = analyses.filter(a => a.admin_score != null).length;

  // Pull existing rules so Opus doesn't propose duplicates
  const { data: existingSonnet } = await admin.from("sonnet_prompts")
    .select("title")
    .eq("workspace_id", workspaceId)
    .in("status", ["approved", "proposed"]);
  const { data: existingGrader } = await admin.from("grader_prompts")
    .select("title")
    .eq("workspace_id", workspaceId)
    .in("status", ["approved", "proposed"]);

  const existingSonnetTitles = (existingSonnet || []).map(r => r.title);
  const existingGraderTitles = (existingGrader || []).map(r => r.title);

  // Build prompt
  const system = buildReportSystemPrompt(date, existingSonnetTitles, existingGraderTitles);
  const userMsg = buildReportUserMessage(date, analyses as AnalysisInput[]);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: REPORT_MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error("[daily-analysis-report] Opus call failed:", res.status, errBody);
    return { ok: false, reason: `opus_${res.status}` };
  }

  const data = await res.json();
  const text = (data?.content?.[0]?.text || "").trim();
  const parsed = parseOpusOutput(text);
  if (!parsed) {
    console.error("[daily-analysis-report] failed to parse Opus output:", text.slice(0, 500));
    return { ok: false, reason: "parse_failed" };
  }

  // Log usage
  await logAiUsage({
    workspaceId,
    model: REPORT_MODEL,
    usage: data.usage,
    purpose: "daily_analysis_report",
    ticketId: null,
  });
  const usage = data.usage || {};
  const costCents = usageCostCents(REPORT_MODEL, {
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_creation_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_tokens: usage.cache_read_input_tokens || 0,
  });

  // Insert proposed rules
  const proposedSonnetIds: string[] = [];
  for (const p of parsed.proposed_sonnet_prompts || []) {
    const { data: ins, error } = await admin.from("sonnet_prompts").insert({
      workspace_id: workspaceId,
      title: p.title,
      content: p.content,
      category: p.category || "rule",
      enabled: false,
      status: "proposed",
      proposed_at: new Date().toISOString(),
      sort_order: 200,
    }).select("id").single();
    if (error) { console.warn("[daily-report] sonnet_prompts insert failed:", error.message); continue; }
    if (ins?.id) proposedSonnetIds.push(ins.id);
  }

  const proposedGraderIds: string[] = [];
  for (const p of parsed.proposed_grader_prompts || []) {
    const { data: ins, error } = await admin.from("grader_prompts").insert({
      workspace_id: workspaceId,
      title: p.title,
      content: p.content,
      status: "proposed",
    }).select("id").single();
    if (error) { console.warn("[daily-report] grader_prompts insert failed:", error.message); continue; }
    if (ins?.id) proposedGraderIds.push(ins.id);
  }

  // Upsert report
  const { data: report, error: rErr } = await admin.from("daily_analysis_reports").upsert({
    workspace_id: workspaceId,
    date,
    analyzed_count: analyses.length,
    avg_score: avg != null ? Math.round(avg * 10) / 10 : null,
    action_items_count: actionItemsCount,
    admin_corrected_count: adminCorrected,
    worst_score: worst,
    best_score: best,
    summary: parsed.summary,
    themes: parsed.themes || [],
    recommendations: parsed.recommendations || [],
    proposed_sonnet_prompt_ids: proposedSonnetIds,
    proposed_grader_prompt_ids: proposedGraderIds,
    model: REPORT_MODEL,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cost_cents: Math.round(costCents * 10000) / 10000,
    generated_at: new Date().toISOString(),
    generated_by: generatedBy,
    trigger,
    updated_at: new Date().toISOString(),
  }, { onConflict: "workspace_id,date" }).select("id").single();

  if (rErr) {
    console.error("[daily-report] upsert failed:", rErr);
    return { ok: false, reason: `upsert_failed_${rErr.code}` };
  }

  return { ok: true, reportId: report?.id, analyzed_count: analyses.length };
}

function buildReportSystemPrompt(date: string, existingSonnet: string[], existingGrader: string[]): string {
  const sonnetList = existingSonnet.length ? existingSonnet.map(t => `  - ${t}`).join("\n") : "  (none yet)";
  const graderList = existingGrader.length ? existingGrader.map(t => `  - ${t}`).join("\n") : "  (none yet)";

  return `You are an AI Quality Analyst writing a daily report for the CX manager at Superfoods Company. Today you are summarizing ${date}.

You will receive a JSON array of per-ticket analyses (each one already graded individually by Sonnet against our rubric). Your job is to find patterns ACROSS tickets — what's repeating, what's systemic, what could be fixed by one prompt change.

OUTPUT GOALS:
  1. summary — 2-3 short paragraphs (5-7 sentences total). Lead with the most important takeaway. Mention concrete ticket counts ("4 of 12 tickets..."). No headers, no bullets, no markdown. Conversational but specific.
  2. themes — cluster the failure modes. Each theme groups ≥2 tickets sharing a root cause. Give it a short name, count, list of ticket_ids, 1-sentence description, and a severity ("high" if it affected the customer's outcome, "medium" if it caused friction, "low" if cosmetic).
  3. recommendations — 1-3 priority-ordered actions the human should consider. Concise.
  4. proposed_sonnet_prompts — RULES TO ADD TO THE AI AGENT (Suzie/Julie). Only propose when the same failure repeats across multiple tickets AND a clear rule would prevent it. Each proposal must have a unique title (not already in the existing list below) and a content body that follows the format: "[Rule]. Why: [reason]. How to apply: [trigger + action]." Don't propose vague aspirations.
  5. proposed_grader_prompts — RULES TO ADD TO THE GRADER (this analyzer). Only propose when the grader scored multiple tickets in a way that seems miscalibrated (too harsh, too lenient, or missed an issue type). Same uniqueness + structure rules as above.

EXISTING APPROVED/PROPOSED SONNET RULES — do NOT duplicate any title:
${sonnetList}

EXISTING APPROVED/PROPOSED GRADER RULES — do NOT duplicate any title:
${graderList}

PROPOSAL RULES:
  - Quality > quantity. 0-2 proposals per category is normal. More than 3 means you're stretching.
  - If no clear pattern emerges, return an empty array for that category. Don't invent rules.
  - Be concrete and surgical. "Be more empathetic" is not a rule. "When a customer mentions a recurring issue, acknowledge the recurrence before offering a fix — current AI jumps straight to the fix" IS a rule.

OUTPUT (JSON only, no prose around it):
{
  "summary": "<2-3 short paragraphs>",
  "themes": [{"name": "...", "count": N, "ticket_ids": ["..."], "description": "...", "severity": "high|medium|low"}],
  "recommendations": [{"priority": "high|medium|low", "description": "..."}],
  "proposed_sonnet_prompts": [{"title": "...", "content": "...", "category": "rule"}],
  "proposed_grader_prompts": [{"title": "...", "content": "..."}]
}`;
}

function buildReportUserMessage(date: string, analyses: AnalysisInput[]): string {
  const compact = analyses.map(a => ({
    ticket_id: a.ticket_id,
    score: a.admin_score ?? a.score,
    admin_overridden: a.admin_score != null,
    admin_reason: a.admin_score_reason || null,
    summary: a.summary,
    issues: (a.issues || []).map(i => `${i.type}: ${i.description}`),
    action_items: (a.action_items || []).map(ai => `[${ai.priority}] ${ai.description}`),
  }));
  return `Generate the daily report for ${date}. Here are ${analyses.length} per-ticket analyses to synthesize:\n\n${JSON.stringify(compact, null, 2)}\n\nReturn the JSON only.`;
}

function parseOpusOutput(text: string): OpusReportOutput | null {
  // Opus sometimes wraps JSON in ```json fences. Strip them.
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    return JSON.parse(stripped) as OpusReportOutput;
  } catch {
    // Last-ditch: try to extract the largest balanced JSON object
    const first = stripped.indexOf("{");
    const last = stripped.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) return null;
    try {
      return JSON.parse(stripped.slice(first, last + 1)) as OpusReportOutput;
    } catch {
      return null;
    }
  }
}
