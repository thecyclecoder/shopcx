/**
 * Auto-review of proposed sonnet_prompts.
 *
 * Reads a workspace's `status='proposed' AND auto_decision IS NULL`
 * prompts, fetches similar approved prompts + relevant policies +
 * source-pattern tickets + voice docs, calls Claude Opus with a
 * decision schema, and applies the decision under Phase 3 safety
 * guards (confidence floor, daily cap, audit-first, supersede-not-
 * delete, per-workspace flag).
 *
 * See docs/brain/specs/prompt-learning.md.
 */
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { resolve } from "path";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage, usageCostCents } from "@/lib/ai-usage";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Constants ──────────────────────────────────────────────────────
export const CONFIDENCE_FLOOR = 0.75;
export const DEFAULT_DAILY_CAP = 10;
export const REVIEW_MODEL = OPUS_MODEL;
const TOP_K_SIMILAR_PROMPTS = 8;
const TOP_K_POLICIES = 10;
const TOP_K_SOURCE_TICKETS = 5;
const MAX_PROPOSALS_PER_CRON_RUN = 50;

// ── Types ──────────────────────────────────────────────────────────
type Admin = SupabaseClient<any, any, any>;

export type DecisionType =
  | "accept"
  | "reject"
  | "merge"
  | "supersede"
  | "human_review"
  | "revise";

export interface ReviewDecision {
  decision: DecisionType;
  confidence: number;
  reasoning: string;
  references: Array<{
    type: "prompt" | "policy" | "ticket" | "voice_rule";
    id: string;
    why: string;
  }>;
  suggested_revisions?: string | null;
  merge_target_id?: string | null;
  supersede_target_id?: string | null;
}

export interface ReviewInputs {
  proposal: any;
  similarPrompts: any[];
  policies: any[];
  sourceTickets: any[];
  voiceDocs: { customer_voice: string; operational_rules: string; ui_conventions: string };
}

export interface ReviewResult {
  ok: boolean;
  decision?: ReviewDecision;
  applied?: boolean;
  reason?: string;
  decisionRowId?: string;
  forcedToHumanReview?: boolean;
}

// ── Voice doc loading (read once, hash for audit) ──────────────────
let cachedVoiceDocs: ReviewInputs["voiceDocs"] | null = null;
let cachedVoiceHashes: Record<string, string> | null = null;

export function loadVoiceDocs(): {
  docs: ReviewInputs["voiceDocs"];
  hashes: Record<string, string>;
} {
  if (cachedVoiceDocs && cachedVoiceHashes) {
    return { docs: cachedVoiceDocs, hashes: cachedVoiceHashes };
  }
  const root = resolve(process.cwd(), "docs/brain");
  const customer_voice = readFileSync(resolve(root, "customer-voice.md"), "utf8");
  const operational_rules = readFileSync(resolve(root, "operational-rules.md"), "utf8");
  const ui_conventions = readFileSync(resolve(root, "ui-conventions.md"), "utf8");
  cachedVoiceDocs = { customer_voice, operational_rules, ui_conventions };
  cachedVoiceHashes = {
    customer_voice: sha(customer_voice),
    operational_rules: sha(operational_rules),
    ui_conventions: sha(ui_conventions),
  };
  return { docs: cachedVoiceDocs, hashes: cachedVoiceHashes };
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// Test-only — reset the cache so the safety test can stub doc content.
export function _resetVoiceDocCacheForTests(): void {
  cachedVoiceDocs = null;
  cachedVoiceHashes = null;
}

// ── Pull the inputs the model sees ─────────────────────────────────
export async function loadReviewInputs(
  admin: Admin,
  workspaceId: string,
  proposal: any,
): Promise<ReviewInputs> {
  const { data: similar } = await admin
    .from("sonnet_prompts")
    .select("id, title, content, category, enabled, status")
    .eq("workspace_id", workspaceId)
    .eq("status", "approved")
    .eq("enabled", true)
    .neq("id", proposal.id)
    .ilike(
      "content",
      // Cheap keyword overlap; pgvector path can be added later.
      `%${proposal.title.split(/\s+/)[0] || ""}%`,
    )
    .limit(TOP_K_SIMILAR_PROMPTS);

  const { data: policies } = await admin
    .from("policies")
    .select("id, slug, name, summary, internal_notes, rules_json")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .is("superseded_by", null)
    .limit(TOP_K_POLICIES);

  // Source pattern → contributing tickets.
  const sourceTickets: any[] = [];
  if (proposal.source_pattern_id || proposal.derived_from_ticket_id) {
    const idsToLoad: string[] = [];
    if (proposal.derived_from_ticket_id) idsToLoad.push(proposal.derived_from_ticket_id);
    if (proposal.source_pattern_id) {
      const { data: report } = await admin
        .from("daily_analysis_reports")
        .select("themes")
        .eq("id", proposal.source_pattern_id)
        .maybeSingle();
      const themes = (report?.themes as any[]) || [];
      for (const t of themes) {
        if (Array.isArray(t?.ticket_ids)) {
          for (const tid of t.ticket_ids.slice(0, TOP_K_SOURCE_TICKETS)) {
            if (!idsToLoad.includes(tid)) idsToLoad.push(tid);
          }
        }
      }
    }
    if (idsToLoad.length) {
      const { data: tx } = await admin
        .from("ticket_analyses")
        .select("ticket_id, summary, issues, action_items, score")
        .in("ticket_id", idsToLoad.slice(0, TOP_K_SOURCE_TICKETS));
      sourceTickets.push(...(tx || []));
    }
  }

  const { docs } = loadVoiceDocs();

  return {
    proposal: {
      id: proposal.id,
      title: proposal.title,
      content: proposal.content,
      category: proposal.category,
    },
    similarPrompts: similar || [],
    policies: policies || [],
    sourceTickets,
    voiceDocs: docs,
  };
}

// ── Build the system + user prompts ────────────────────────────────
export function buildSystemPrompt(): string {
  return `You are reviewing a proposed sonnet_prompt rule for a customer-service AI agent. Your job: decide whether the proposal should be accepted, rejected, merged with an existing rule, supersede an existing rule, sent to human_review, or returned with suggested revisions.

You must honor four hard rules:

1. **Never recommend deleting an approved prompt.** If the proposal contradicts or replaces an existing approved rule, the correct decision is "supersede" with the supersede_target_id set, NOT delete. The old rule will be disabled but kept.
2. **Decisions are LIVE on enabled workspaces.** Only confidence ≥ 0.75 will auto-apply; below that, the system forces human_review regardless of your recommendation. Be honest about uncertainty — when in doubt, lower the confidence.
3. **Voice rules from docs/brain/customer-voice.md govern tone.** If the proposal violates a voice rule (e.g. suggests re-greeting on follow-ups, suggests apologizing for charges customers signed up for, suggests revealing the AI persona), reject it with a reference to the relevant voice rule.
4. **Source tickets are evidence, not law.** A pattern across 3+ tickets is enough to justify a rule. A single ticket is not — recommend human_review for one-shot proposals.

Output JSON exactly matching this schema:

\`\`\`json
{
  "decision": "accept" | "reject" | "merge" | "supersede" | "human_review" | "revise",
  "confidence": 0.0..1.0,
  "reasoning": "one paragraph explaining the decision",
  "references": [
    {"type": "prompt" | "policy" | "ticket" | "voice_rule", "id": "string", "why": "string"}
  ],
  "suggested_revisions": "string, only when decision='revise'",
  "merge_target_id": "uuid, only when decision='merge'",
  "supersede_target_id": "uuid, only when decision='supersede'"
}
\`\`\`

Return only the JSON. No markdown fences, no commentary outside the object.`;
}

export function buildUserPrompt(inputs: ReviewInputs): string {
  const { proposal, similarPrompts, policies, sourceTickets, voiceDocs } = inputs;
  return [
    "## Proposed prompt",
    `- id: ${proposal.id}`,
    `- title: ${proposal.title}`,
    `- category: ${proposal.category || "rule"}`,
    `- content:\n${proposal.content}`,
    "",
    `## Similar approved prompts (${similarPrompts.length})`,
    similarPrompts.length
      ? similarPrompts
          .map((p: any) => `- ${p.id} · "${p.title}" (${p.category})\n  content: ${p.content}`)
          .join("\n\n")
      : "_None._",
    "",
    `## Active policies (${policies.length})`,
    policies.length
      ? policies.map((p: any) => `- ${p.slug}: ${p.name}\n  summary: ${p.summary || ""}\n  internal: ${p.internal_notes || ""}`).join("\n\n")
      : "_None._",
    "",
    `## Source pattern — contributing tickets (${sourceTickets.length})`,
    sourceTickets.length
      ? sourceTickets
          .map((t: any) => `- ${t.ticket_id} · score=${t.score}\n  summary: ${t.summary}`)
          .join("\n\n")
      : "_None — single-ticket or no source data; lean toward human_review._",
    "",
    "## Voice rules (excerpt from docs/brain/customer-voice.md)",
    voiceDocs.customer_voice.slice(0, 6000),
    "",
    "## Operational rules (excerpt)",
    voiceDocs.operational_rules.slice(0, 4000),
  ].join("\n");
}

// ── Call Opus ──────────────────────────────────────────────────────
export async function callOpusReview(
  inputs: ReviewInputs,
): Promise<{
  ok: boolean;
  decision?: ReviewDecision;
  raw?: any;
  reason?: string;
  usage?: any;
  latencyMs?: number;
}> {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: "no_api_key" };

  const t0 = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: REVIEW_MODEL,
      max_tokens: 2000,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: buildUserPrompt(inputs) }],
    }),
  });

  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    return { ok: false, reason: `opus_${res.status}`, latencyMs };
  }
  const raw = await res.json();
  const text = (raw?.content?.[0]?.text || "").trim();
  const parsed = parseDecision(text);
  if (!parsed) return { ok: false, reason: "parse_failed", raw, latencyMs };
  return { ok: true, decision: parsed, raw, usage: raw.usage, latencyMs };
}

export function parseDecision(text: string): ReviewDecision | null {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  let obj: any = null;
  try {
    obj = JSON.parse(stripped);
  } catch {
    const first = stripped.indexOf("{");
    const last = stripped.lastIndexOf("}");
    if (first === -1 || last === -1) return null;
    try {
      obj = JSON.parse(stripped.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const decision = obj.decision;
  if (!["accept", "reject", "merge", "supersede", "human_review", "revise"].includes(decision)) return null;
  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (typeof obj.reasoning !== "string" || !obj.reasoning.length) return null;
  return {
    decision,
    confidence,
    reasoning: obj.reasoning,
    references: Array.isArray(obj.references) ? obj.references : [],
    suggested_revisions: obj.suggested_revisions || null,
    merge_target_id: obj.merge_target_id || null,
    supersede_target_id: obj.supersede_target_id || null,
  };
}

// ── Daily-cap check ────────────────────────────────────────────────
export async function acceptsRemainingToday(
  admin: Admin,
  workspaceId: string,
  dailyCap: number,
): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count } = await admin
    .from("sonnet_prompt_decisions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("decision", "accept")
    .eq("source", "cron")
    .gte("created_at", since.toISOString());
  return Math.max(0, dailyCap - (count || 0));
}

// ── Apply decision (Phase 3: audit-first transaction-shape) ────────
export async function applyDecision(
  admin: Admin,
  workspaceId: string,
  proposal: any,
  rawDecision: ReviewDecision,
  inputs: ReviewInputs,
  modelMeta: {
    model: string;
    usage?: any;
    latencyMs?: number;
    source?: "cron" | "manual_override" | "safety_test";
    performedBy?: string;
  },
  opts: { dailyCap: number; alreadyAcceptedToday?: number },
): Promise<{
  applied: boolean;
  forcedToHumanReview: boolean;
  decisionRowId: string;
  finalDecision: DecisionType;
  reason?: string;
}> {
  // Phase 3 safety gates BEFORE we touch sonnet_prompts.
  let finalDecision = rawDecision.decision;
  let forcedToHumanReview = false;
  let reason: string | undefined;

  if (rawDecision.confidence < CONFIDENCE_FLOOR) {
    finalDecision = "human_review";
    forcedToHumanReview = true;
    reason = `confidence_floor (${rawDecision.confidence.toFixed(2)} < ${CONFIDENCE_FLOOR})`;
  }

  // Daily cap (only for accept; supersede/merge etc. don't count).
  if (finalDecision === "accept" && modelMeta.source === "cron") {
    const acceptedToday = opts.alreadyAcceptedToday ?? 0;
    if (acceptedToday >= opts.dailyCap) {
      finalDecision = "human_review";
      forcedToHumanReview = true;
      reason = `daily_cap (${acceptedToday}/${opts.dailyCap})`;
    }
  }

  // Hard safety: NEVER allow a delete-style decision. Map to supersede.
  if ((finalDecision as string) === "delete") {
    finalDecision = "supersede";
    forcedToHumanReview = true;
    reason = "delete_rewritten_to_supersede";
  }

  // Compute cost for accounting.
  const u = modelMeta.usage || {};
  const cost = usageCostCents(modelMeta.model, {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_creation_tokens: u.cache_creation_input_tokens || 0,
    cache_read_tokens: u.cache_read_input_tokens || 0,
  });

  // ── Step 1: audit row FIRST. If this fails, we abort without touching
  //   the prompt. We can't get a real DB transaction across two
  //   supabase-js calls; we approximate by writing the audit first and
  //   verifying its id before mutating the prompt row.
  const auditRow = {
    workspace_id: workspaceId,
    sonnet_prompt_id: proposal.id,
    decision: finalDecision,
    confidence: rawDecision.confidence,
    reasoning: reason ? `${rawDecision.reasoning}\n\n[SAFETY] ${reason}` : rawDecision.reasoning,
    references_json: rawDecision.references,
    suggested_revisions: rawDecision.suggested_revisions || null,
    merge_target_id: finalDecision === "merge" ? rawDecision.merge_target_id : null,
    supersede_target_id: finalDecision === "supersede" ? rawDecision.supersede_target_id : null,
    input_proposal: inputs.proposal,
    input_similar_prompts: inputs.similarPrompts,
    input_policies: inputs.policies,
    input_source_tickets: inputs.sourceTickets,
    input_voice_doc_hashes: loadVoiceDocs().hashes,
    model: modelMeta.model,
    input_tokens: u.input_tokens || null,
    output_tokens: u.output_tokens || null,
    cost_usd_cents: cost,
    latency_ms: modelMeta.latencyMs || null,
    source: modelMeta.source || "cron",
    performed_by: modelMeta.performedBy || null,
  };
  const { data: audit, error: auditErr } = await admin
    .from("sonnet_prompt_decisions")
    .insert(auditRow)
    .select("id")
    .single();
  if (auditErr || !audit?.id) {
    return {
      applied: false,
      forcedToHumanReview,
      decisionRowId: "",
      finalDecision,
      reason: `audit_insert_failed: ${auditErr?.message || "no id"}`,
    };
  }

  // ── Step 2: mutate the prompt row according to the decision.
  const promptUpdates: Record<string, any> = {
    auto_decision: finalDecision,
    auto_decision_at: new Date().toISOString(),
    auto_decision_reason: rawDecision.reasoning.slice(0, 2000),
    auto_decision_model: modelMeta.model,
    auto_decision_confidence: rawDecision.confidence,
  };

  switch (finalDecision) {
    case "accept":
      promptUpdates.status = "approved";
      promptUpdates.reviewed_at = new Date().toISOString();
      break;
    case "reject":
      promptUpdates.status = "rejected";
      promptUpdates.reviewed_at = new Date().toISOString();
      promptUpdates.enabled = false;
      break;
    case "merge":
      if (rawDecision.merge_target_id) {
        promptUpdates.merged_into_id = rawDecision.merge_target_id;
        promptUpdates.status = "rejected";
        promptUpdates.enabled = false;
      } else {
        // Missing target — degrade.
        promptUpdates.auto_decision = "human_review";
        promptUpdates.status = "proposed";
      }
      break;
    case "supersede":
      if (rawDecision.supersede_target_id) {
        promptUpdates.status = "approved";
        promptUpdates.reviewed_at = new Date().toISOString();
        // The new proposal supersedes the old one. Disable the old.
        await admin
          .from("sonnet_prompts")
          .update({
            superseded_by_id: proposal.id,
            enabled: false,
            status: "archived",
          })
          .eq("id", rawDecision.supersede_target_id)
          .eq("workspace_id", workspaceId);
      } else {
        promptUpdates.auto_decision = "human_review";
        promptUpdates.status = "proposed";
      }
      break;
    case "revise":
      // Stays as proposed; the suggested_revisions live on the audit row.
      promptUpdates.status = "proposed";
      break;
    case "human_review":
      promptUpdates.status = "proposed";
      // Stamp a tag-style flag via the existing `tags`-shaped path:
      // simplest is to leave status=proposed and let the dashboard sort
      // by auto_decision='human_review'.
      break;
  }

  const { error: updErr } = await admin
    .from("sonnet_prompts")
    .update(promptUpdates)
    .eq("id", proposal.id)
    .eq("workspace_id", workspaceId);
  if (updErr) {
    return {
      applied: false,
      forcedToHumanReview,
      decisionRowId: audit.id,
      finalDecision,
      reason: `prompt_update_failed: ${updErr.message}`,
    };
  }

  // Token usage accounting.
  if (modelMeta.usage) {
    try {
      await logAiUsage({
        workspaceId,
        model: modelMeta.model,
        usage: modelMeta.usage,
        purpose: "sonnet_prompt_auto_review",
        ticketId: null,
      });
    } catch {}
  }

  return {
    applied: finalDecision !== "human_review",
    forcedToHumanReview,
    decisionRowId: audit.id,
    finalDecision,
    reason,
  };
}

// ── End-to-end review for a single proposal (the cron's worker) ────
export async function reviewSingleProposal(
  admin: Admin,
  workspaceId: string,
  proposal: any,
  options: { dailyCap: number; alreadyAcceptedToday: number; source?: "cron" | "safety_test" } = {
    dailyCap: DEFAULT_DAILY_CAP,
    alreadyAcceptedToday: 0,
  },
): Promise<ReviewResult> {
  try {
    const inputs = await loadReviewInputs(admin, workspaceId, proposal);
    const opus = await callOpusReview(inputs);
    if (!opus.ok || !opus.decision) {
      return { ok: false, reason: opus.reason || "opus_failed" };
    }
    const applied = await applyDecision(
      admin,
      workspaceId,
      proposal,
      opus.decision,
      inputs,
      {
        model: REVIEW_MODEL,
        usage: opus.usage,
        latencyMs: opus.latencyMs,
        source: options.source || "cron",
      },
      { dailyCap: options.dailyCap, alreadyAcceptedToday: options.alreadyAcceptedToday },
    );
    return {
      ok: applied.applied || applied.finalDecision === "human_review",
      decision: opus.decision,
      applied: applied.applied,
      decisionRowId: applied.decisionRowId,
      forcedToHumanReview: applied.forcedToHumanReview,
      reason: applied.reason,
    };
  } catch (err: any) {
    return { ok: false, reason: `exception: ${err?.message || "unknown"}` };
  }
}

// ── Workspace sweep ────────────────────────────────────────────────
export async function reviewWorkspace(
  admin: Admin,
  workspaceId: string,
): Promise<{ reviewed: number; accepted: number; humanReview: number; errors: string[] }> {
  const errors: string[] = [];
  let reviewed = 0,
    accepted = 0,
    humanReview = 0;

  const { data: ws } = await admin
    .from("workspaces")
    .select("sonnet_auto_review_enabled, sonnet_auto_review_daily_cap")
    .eq("id", workspaceId)
    .single();
  if (!ws?.sonnet_auto_review_enabled) {
    return { reviewed: 0, accepted: 0, humanReview: 0, errors: ["disabled"] };
  }
  const dailyCap = ws.sonnet_auto_review_daily_cap || DEFAULT_DAILY_CAP;

  const { data: proposals } = await admin
    .from("sonnet_prompts")
    .select("id, title, content, category, source_pattern_id, derived_from_ticket_id")
    .eq("workspace_id", workspaceId)
    .eq("status", "proposed")
    .is("auto_decision", null)
    .order("proposed_at", { ascending: true })
    .limit(MAX_PROPOSALS_PER_CRON_RUN);

  if (!proposals?.length) return { reviewed: 0, accepted: 0, humanReview: 0, errors };

  let acceptedToday = (await acceptsRemainingToday(admin, workspaceId, dailyCap)) === dailyCap
    ? 0
    : dailyCap - (await acceptsRemainingToday(admin, workspaceId, dailyCap));

  for (const p of proposals) {
    const r = await reviewSingleProposal(admin, workspaceId, p, {
      dailyCap,
      alreadyAcceptedToday: acceptedToday,
      source: "cron",
    });
    reviewed++;
    if (r.ok && r.decision) {
      if (r.applied && r.decision.decision === "accept") {
        accepted++;
        acceptedToday++;
      }
      if (r.forcedToHumanReview || r.decision.decision === "human_review") humanReview++;
    } else {
      errors.push(`${p.id}: ${r.reason}`);
    }
  }

  return { reviewed, accepted, humanReview, errors };
}
