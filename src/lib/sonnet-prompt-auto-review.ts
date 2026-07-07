/**
 * Auto-review of proposed sonnet_prompts.
 *
 * Reads a workspace's `status='proposed' AND auto_decision IS NULL`
 * prompts, assembles similar approved prompts + relevant policies +
 * source-pattern tickets + voice docs into the review inputs a
 * supervised box-session agent (kind='prompt-review', dispatched by
 * scripts/builder-worker.ts under June, the CS Director) consumes.
 * The agent emits a per-proposal verdict; the deterministic worker
 * applies it via `applyDecision` under Phase 3 safety guards
 * (confidence floor, daily cap, audit-first, supersede-not-delete,
 * per-workspace flag). No code path here calls api.anthropic.com
 * directly — the north-star cascade is CEO → June (CS Director) →
 * the box agent, never a headless raw-API cron.
 *
 * See docs/brain/specs/prompt-learning.md and
 * docs/brain/specs/prompt-auto-review-becomes-box-agent-under-june.md.
 */
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { resolve } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage, usageCostCents } from "@/lib/ai-usage";
import { applyReviewDecision as applyReviewDecisionSdk, archiveSupersededPrompt } from "@/lib/sonnet-prompts-table";

// ── Constants ──────────────────────────────────────────────────────
// Below this confidence, we DROP (reject) the proposal — not bother
// Dylan with it. The agent has a strong opinion that low-confidence
// proposals shouldn't accumulate in a human queue; they should just
// die. If the underlying pattern is real, it'll resurface with more
// evidence next time and clear the bar.
export const REJECT_FLOOR = 0.55;
// Above this confidence, an accept lands as approved. Below this
// (but above REJECT_FLOOR), the model's recommendation is trusted
// EXCEPT accepts get downgraded to reject — we want decisive
// rejects, never tentative accepts.
export const ACCEPT_FLOOR = 0.70;
export const DEFAULT_DAILY_CAP = 10;
export const REVIEW_MODEL = OPUS_MODEL;
const TOP_K_SIMILAR_PROMPTS = 8;
const TOP_K_POLICIES = 10;
const TOP_K_SOURCE_TICKETS = 5;
// Per-tick cap on how many kind='prompt-review' agent_jobs the
// sonnet-prompt-auto-review Inngest cron enqueues across a single
// workspace's proposed-prompt backlog. A large backlog drains over
// consecutive daily ticks so the box's concurrency-1 review lane
// never floods.
export const MAX_PROPOSALS_PER_CRON_RUN = 50;

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
  return `You are reviewing a proposed sonnet_prompt rule for a customer-service AI agent. Your job: decide whether the proposal should be accepted, rejected, merged with an existing rule, supersede an existing rule, or returned with suggested revisions. **You must decide.** There is no human-review queue — if you're not confident, REJECT. The pattern will resurface with more evidence next time if it's real.

Hard rules:

1. **Never recommend deleting an approved prompt.** If the proposal contradicts or replaces an existing approved rule, the correct decision is "supersede" with the supersede_target_id set, NOT delete. The old rule will be disabled but kept.
2. **No human queue.** Don't punt. The four real decisions are: accept (≥0.70 confidence), reject (drop it), merge (combine into an existing rule), supersede (replace an existing rule). If the proposal has merit but isn't ready, REJECT — the upstream pipeline will resurface it with more evidence later.
3. **Voice rules from docs/brain/customer-voice.md govern tone.** If the proposal violates a voice rule (e.g. suggests re-greeting on follow-ups, apologizing for charges customers signed up for, revealing the AI persona), reject it with a reference to the relevant voice rule.
4. **Source tickets are evidence, but absence isn't disqualifying.** A pattern across 3+ tickets strongly supports a rule. A proposal with zero source tickets attached is still a fair candidate IF the rule articulates a clear principle aligned with existing voice/operational rules and doesn't conflict with anything. Don't reject solely on "single ticket" or "no tickets" — reject if the rule itself is weak, redundant, or wrong.
5. **Be decisive.** Tentative accepts get auto-downgraded to reject. If you want this to land, your confidence should be ≥0.70. If it's lower than that, you're really saying "reject" — just say it.

Output JSON exactly matching this schema:

\`\`\`json
{
  "decision": "accept" | "reject" | "merge" | "supersede" | "revise",
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
      : "_None — no source pattern attached. That's not by itself disqualifying; judge the rule on its merits against the voice + operational rules below._",
    "",
    "## Voice rules (excerpt from docs/brain/customer-voice.md)",
    voiceDocs.customer_voice.slice(0, 6000),
    "",
    "## Operational rules (excerpt)",
    voiceDocs.operational_rules.slice(0, 4000),
  ].join("\n");
}

// ── Parse the box-session verdict ──────────────────────────────────
// The direct-Opus fetch that used to live here was retired: the
// cron now enqueues a kind='prompt-review' box-session agent job
// (scripts/builder-worker.ts → runPromptReviewJob) that emits the
// same JSON verdict as a supervised agent session under June (CS
// Director), and the deterministic runner calls `applyDecision`
// with the parsed verdict — the north-star cascade CEO → role
// agent → tool. No code path in the auto-review calls
// api.anthropic.com directly.
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
  // Phase 3 safety gates BEFORE we touch sonnet_prompts. We DO NOT
  // route to human_review from the cron — Dylan explicitly doesn't
  // want a queue accumulating for him to process. If the model isn't
  // confident, we drop (reject); the pattern will resurface with
  // more evidence next time if it's real.
  let finalDecision = rawDecision.decision;
  let forcedDowngrade = false;
  let reason: string | undefined;

  // 1. Hard floor — anything below REJECT_FLOOR gets dropped.
  if (rawDecision.confidence < REJECT_FLOOR) {
    finalDecision = "reject";
    forcedDowngrade = true;
    reason = `confidence_below_reject_floor (${rawDecision.confidence.toFixed(2)} < ${REJECT_FLOOR}) — dropping rather than queuing for human review`;
  }
  // 2. Accept floor — accepts below ACCEPT_FLOOR get downgraded to reject.
  //    Never auto-apply a tentative accept; reject and let it resurface
  //    with stronger evidence next time.
  else if (finalDecision === "accept" && rawDecision.confidence < ACCEPT_FLOOR) {
    finalDecision = "reject";
    forcedDowngrade = true;
    reason = `accept_below_floor (${rawDecision.confidence.toFixed(2)} < ${ACCEPT_FLOOR}) — downgraded to reject; resurface with more evidence`;
  }
  // 3. Model returned human_review — we override that. Trust the
  //    reasoning content; treat as reject. (The model still expresses
  //    its hesitation in the audit reasoning.)
  else if ((finalDecision as string) === "human_review") {
    finalDecision = "reject";
    forcedDowngrade = true;
    reason = `model_recommended_human_review_overridden_to_reject — auto-review never queues to humans`;
  }

  // Daily cap on accepts — past the cap, reject instead of queueing.
  if (finalDecision === "accept" && modelMeta.source === "cron") {
    const acceptedToday = opts.alreadyAcceptedToday ?? 0;
    if (acceptedToday >= opts.dailyCap) {
      finalDecision = "reject";
      forcedDowngrade = true;
      reason = `daily_cap_reached (${acceptedToday}/${opts.dailyCap}) — dropping; rerun tomorrow`;
    }
  }

  // Hard safety: NEVER allow a delete-style decision. Map to supersede.
  if ((finalDecision as string) === "delete") {
    finalDecision = "supersede";
    forcedDowngrade = true;
    reason = "delete_rewritten_to_supersede";
  }

  // Missing-target safety: merge needs merge_target_id, supersede needs
  // supersede_target_id. If the model returned the decision without a
  // target, we can't apply it — downgrade to reject (same philosophy as
  // the confidence floors: never queue to a human, drop and resurface).
  if (finalDecision === "merge" && !rawDecision.merge_target_id) {
    finalDecision = "reject";
    forcedDowngrade = true;
    reason = "merge_without_target_downgraded_to_reject";
  }
  if (finalDecision === "supersede" && !rawDecision.supersede_target_id) {
    finalDecision = "reject";
    forcedDowngrade = true;
    reason = "supersede_without_target_downgraded_to_reject";
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
    cost_usd_cents: Math.round(cost),
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
      forcedToHumanReview: forcedDowngrade,
      decisionRowId: "",
      finalDecision,
      reason: `audit_insert_failed: ${auditErr?.message || "no id"}`,
    };
  }

  // ── Step 2: mutate the prompt row through the sonnet-prompts SDK. The SDK owns the
  //   decision→row mapping (status/enabled/reviewed_at + all five auto_decision columns) so no
  //   two callers can drift on which combination each verdict writes. `applyReviewDecision`
  //   compare-and-sets on (id, workspace_id) and asserts one row transitioned — a race with a
  //   manual override lands here as `rows=0` rather than a silent double-write.
  //   ([[sonnet-prompts-table]] · sonnet-prompts-sdk-for-review-agent-db-access Phase 1.)
  const applied = await applyReviewDecisionSdk(admin, {
    workspaceId,
    promptId: proposal.id,
    finalDecision,
    reasoning: rawDecision.reasoning,
    confidence: rawDecision.confidence,
    model: modelMeta.model,
    mergeTargetId: finalDecision === "merge" ? rawDecision.merge_target_id ?? null : null,
    supersedeTargetId: finalDecision === "supersede" ? rawDecision.supersede_target_id ?? null : null,
  });
  if (!applied.ok) {
    return {
      applied: false,
      forcedToHumanReview: forcedDowngrade,
      decisionRowId: audit.id,
      finalDecision,
      reason: `prompt_update_failed: ${applied.error ?? "unknown"}`,
    };
  }
  // On supersede, archive the OLD row (superseded_by_id + status='archived' + enabled=false).
  // Never delete — a supersede is reversible ([[../tables/sonnet_prompts]]).
  if (finalDecision === "supersede" && rawDecision.supersede_target_id) {
    const archived = await archiveSupersededPrompt(admin, {
      workspaceId,
      oldPromptId: rawDecision.supersede_target_id,
      newPromptId: proposal.id,
    });
    if (!archived.ok) {
      // The NEW row already landed as approved; log the archive failure so a supervisor sees why
      // the OLD row didn't archive, but don't roll back the accepted supersede.
      console.warn(`[applyDecision] supersede archive failed: ${archived.error ?? "unknown"}`);
    }
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
    applied: true,
    forcedToHumanReview: forcedDowngrade,
    decisionRowId: audit.id,
    finalDecision,
    reason,
  };
}

// ── End-to-end review is now a box-session agent ──────────────────
// The previous `reviewSingleProposal` + `reviewWorkspace` functions
// (which called `callOpusReview` → api.anthropic.com directly from
// the Inngest cron) are retired. Each proposal is now a kind=
// 'prompt-review' agent_jobs row that scripts/builder-worker.ts →
// runPromptReviewJob dispatches as a Max box session under June (CS
// Director), and the deterministic worker calls `applyDecision`
// with the parsed verdict. The Inngest cron
// (src/lib/inngest/sonnet-prompt-auto-review.ts) enqueues those
// rows — see docs/brain/inngest/sonnet-prompt-auto-review.md.

