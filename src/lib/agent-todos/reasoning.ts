/**
 * Agent To-Do system — the reasoning pass.
 *
 * For each escalated ticket without an active todo group, gather full context,
 * reason with Opus about the gap, and write proposed todos to agent_todos.
 *
 * Used by:
 *   - the hourly Claude Code Routine (scripts/agent-todo-routine-run.ts)
 *   - the Phase 5 backfill (scripts/agent-todo-backfill.ts)
 *
 * The Routine additionally reads the brain pages (customer-voice.md,
 * operational-rules.md, the matching lifecycle/playbook) before this runs and
 * passes a condensed brief via `brainBrief`. When called without a brief (e.g.
 * a Vercel-side invocation), the embedded guidance in SYSTEM_PROMPT applies.
 *
 * Safety: this only PROPOSES (writes status='pending' rows). Nothing executes
 * without a separate human approval. See docs/brain/specs/agent-todo-system.md.
 */
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { OPUS_MODEL } from "@/lib/ai-models";
import { buildPreExecContext } from "./execute";
import type { AgentTodoActionType, AgentTodoUrgency } from "./constants";

type Admin = ReturnType<typeof createAdminClient>;

export interface ReasoningOptions {
  workspaceId: string;
  /** Restrict to these ticket ids (backfill). Omit → all escalated tickets. */
  ticketIds?: string[];
  /** Don't write rows; return what would be proposed. */
  dryRun?: boolean;
  /** Condensed brain guidance the Routine reads + passes in. */
  brainBrief?: string;
  /** Tag the proposed rows with the routine pass id. */
  routineRunId?: string;
  /** Repo root for the Agent SDK to use as cwd (for Read/Grep/Bash tool access). Defaults to process.cwd(). */
  repoDir?: string;
}

interface ProposedTodo {
  action_type: AgentTodoActionType;
  summary: string;
  urgency: AgentTodoUrgency;
  confidence: number;
  payload: Record<string, unknown>;
}

interface ReasoningOutput {
  decision: string;
  context_what_happened: string;
  context_what_we_propose: string;
  urgency: AgentTodoUrgency;
  todos: ProposedTodo[];
}

export interface ReasoningResult {
  ticketId: string;
  proposed: ProposedTodo[];
  groupId?: string;
  skipped?: string;
  error?: string;
}

const SYSTEM_PROMPT = `You are the To-Do reasoning agent for Superfoods Company's retention platform.

An escalated support ticket was handed to you because the AI orchestrator could not resolve it. Your job is to reason about what the customer wanted, what the AI did, where the gap is, and propose concrete actions a human will approve.

You NEVER execute anything. You only propose. A human approves every action.

Decide ONE of:
- no_action: false-positive escalation, nothing wrong → propose a single ticket_close (urgency=low).
- customer_fix: the customer needs a reply and/or account changes → propose 1 customer_reply plus N customer_action todos (one per mutation).
- system_gap: additionally a system change would prevent recurrence → propose sonnet_prompt_new/edit, brain_doc_edit, or code_change.
- analysis_gap: the ticket_analyses score was wrong → propose ticket_analysis_rescore (and grader_prompt_edit if it's a pattern).
- escalation_false_positive: the auto-escalation rule misfired → propose escalation_rule_fix.

Customer voice rules (hard): plain text, NO markdown. Max 2 sentences per paragraph. Mirror the customer's language. Do not apologize for things the customer did. Do not over-explain. Sign off as a teammate, not "AI".

customer_reply payload: { "body_html": "<p>...</p>", } — the exact HTML the customer sees, plain conversational text wrapped in <p> tags.

customer_action payload: { "actions": [ { "type": "<action>", ...params } ], "diff_summary": "<one human line>" }. Valid action types and params (use the customer's internal subscription UUID for contract_id; the executor resolves it):
  remove_item {contract_id, variant_id}
  add_item {contract_id, variant_id, quantity}
  swap_variant {contract_id, old_variant_id, new_variant_id, quantity}
  change_frequency {contract_id, interval, interval_count}
  change_next_date {contract_id, date}
  pause_timed {contract_id, pause_days}   (30 or 60 only)
  skip_next_order {contract_id}
  partial_refund {shopify_order_id, amount_cents, reason}
  create_return {order_number, free_label}
  apply_coupon {contract_id, code}

ticket_close payload: {}.
ticket_analysis_rescore payload: { "ticket_analysis_id": "...", "score": N, "summary": "...", "issues": [{"type":"...","description":"..."}] }.
sonnet_prompt_new / sonnet_prompt_edit payload: { "title": "...", "category": "rule|approach|tool_hint|personality|knowledge", "content": "...", "target_prompt_id"?: "..." }.
brain_doc_edit payload: { "file_path": "docs/brain/...", "unified_diff"|"new_file_body": "...", "rationale": "...", "auto_merge"?: bool }. Only propose file_paths under docs/brain/ that you have actual context for. Never guess at file structure.

code_change / grader_prompt_edit / escalation_rule_fix payload: STRONGLY PREFER routing these through a sonnet_prompt_new (for rule changes) or brain_doc_edit (for documented policy/behavior fixes) instead of generating a unified_diff against unknown TypeScript source.

You do NOT have file-system access during reasoning. You do NOT know the actual layout of src/. Any file_path you propose for code_change-style todos must reference a file you have direct evidence exists (from the customer-voice brain pages, operational-rules.md, or other context loaded into this prompt). If you can't cite the exact existing file, DO NOT propose a code_change — propose a sonnet_prompt instead and describe the behavior change in natural language. The orchestrator reads sonnet_prompts at every turn and will apply the new behavior immediately.

If a code-level fix is truly necessary and you have no concrete file_path, capture the proposal as a sonnet_prompt with category="knowledge" titled "Code follow-up needed: ..." with the diagnosis in content. Dylan will pick it up in a Claude chat session and implement it manually. Never hallucinate file paths or generate diffs against files you haven't been shown.

This project is TypeScript / Next.js / Supabase. There are NO Python files. Threat-detector code, grader prompts, and escalation rules all live in TypeScript (e.g. src/lib/ticket-analyzer.ts). If you don't know the exact path, route to sonnet_prompt.

Write context_what_happened (one short paragraph) and context_what_we_propose (one paragraph or short bullets) so a reviewer can act WITHOUT reading the full conversation. Be specific and concrete.

Call propose_todos exactly once.`;

const TOOL = {
  name: "propose_todos",
  description: "Propose the set of todos for this escalated ticket.",
  input_schema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["no_action", "customer_fix", "system_gap", "analysis_gap", "escalation_false_positive"],
      },
      context_what_happened: { type: "string" },
      context_what_we_propose: { type: "string" },
      urgency: { type: "string", enum: ["urgent", "normal", "low"] },
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action_type: {
              type: "string",
              enum: [
                "customer_reply",
                "customer_action",
                "ticket_close",
                "sonnet_prompt_new",
                "sonnet_prompt_edit",
                "ticket_analysis_rescore",
                "grader_prompt_edit",
                "escalation_rule_fix",
                "brain_doc_edit",
                "code_change",
              ],
            },
            summary: { type: "string" },
            urgency: { type: "string", enum: ["urgent", "normal", "low"] },
            confidence: { type: "number" },
            payload: { type: "object" },
          },
          required: ["action_type", "summary", "payload"],
        },
      },
    },
    required: ["decision", "context_what_happened", "context_what_we_propose", "urgency", "todos"],
  },
} as const;

/** Tickets that are escalated and have no active (pending/approved/executed) todo group. */
export async function findEscalatedNeedingTodos(admin: Admin, workspaceId: string): Promise<string[]> {
  const { data: tickets } = await admin
    .from("tickets")
    .select("id")
    .eq("workspace_id", workspaceId)
    .not("escalated_at", "is", null)
    .neq("status", "archived");
  const ids = (tickets || []).map((t) => t.id);
  if (!ids.length) return [];

  const { data: existing } = await admin
    .from("agent_todos")
    .select("source_ticket_id, status")
    .in("source_ticket_id", ids)
    .in("status", ["pending", "approved", "executed"]);
  const taken = new Set((existing || []).map((t) => t.source_ticket_id));
  return ids.filter((id) => !taken.has(id));
}

async function gatherContext(admin: Admin, workspaceId: string, ticketId: string): Promise<string> {
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, subject, channel, status, escalation_reason, escalated_at, customer_id")
    .eq("id", ticketId)
    .single();
  if (!ticket) return "";

  const { data: messages } = await admin
    .from("ticket_messages")
    .select("author_type, direction, visibility, body, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true })
    .limit(60);

  const lines: string[] = [];
  lines.push(`TICKET ${ticketId}`);
  lines.push(`Subject: ${ticket.subject || "(none)"}`);
  lines.push(`Channel: ${ticket.channel} · Status: ${ticket.status} · Escalation reason: ${ticket.escalation_reason || "(none)"}`);

  if (ticket.customer_id) {
    const { data: cust } = await admin
      .from("customers")
      .select("id, first_name, last_name, email")
      .eq("id", ticket.customer_id)
      .single();
    lines.push(`Customer: ${cust?.first_name || ""} ${cust?.last_name || ""} <${cust?.email || ""}> (id ${ticket.customer_id})`);

    const { data: subs } = await admin
      .from("subscriptions")
      .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", ticket.customer_id);
    if (subs?.length) {
      lines.push(`SUBSCRIPTIONS:`);
      for (const s of subs) {
        const items = (s.items as Array<{ title?: string; variant_id?: string; quantity?: number }> | null) || [];
        const itemStr = items.map((i) => `${i.title || "?"}${i.variant_id ? ` (variant ${i.variant_id})` : ""} x${i.quantity ?? 1}`).join(", ");
        lines.push(`  - sub ${s.id} [${s.status}] every ${s.billing_interval_count} ${s.billing_interval}, next ${s.next_billing_date}: ${itemStr}`);
      }
    }

    const { data: orders } = await admin
      .from("orders")
      .select("order_number, shopify_order_id, total_cents, financial_status, created_at")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", ticket.customer_id)
      .order("created_at", { ascending: false })
      .limit(5);
    if (orders?.length) {
      lines.push(`RECENT ORDERS:`);
      for (const o of orders) {
        lines.push(`  - #${o.order_number} (shopify ${o.shopify_order_id}) $${((o.total_cents || 0) / 100).toFixed(2)} ${o.financial_status} ${o.created_at?.slice(0, 10)}`);
      }
    }
  }

  const { data: analysis } = await admin
    .from("ticket_analyses")
    .select("id, score, summary, issues")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (analysis) {
    lines.push(`LATEST ANALYSIS (id ${analysis.id}): score ${analysis.score}/10 — ${analysis.summary || ""}`);
    lines.push(`  issues: ${JSON.stringify(analysis.issues || [])}`);
  }

  lines.push(`\nCONVERSATION:`);
  for (const m of messages || []) {
    const who = m.author_type + (m.visibility === "internal" ? "/internal" : "");
    const body = (m.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    lines.push(`[${who}] ${body}`);
  }

  return lines.join("\n");
}

/**
 * Reason via the Claude Agent SDK so Opus has Read/Glob/Grep/Bash tool
 * access to the actual cloned repo during reasoning. Without this, the
 * model hallucinates file paths (we hit "escalation/rules/threat_language.py"
 * — a Python file in our TypeScript project — on 2026-06-04).
 *
 * Auth: the Agent SDK respects whatever the host environment provides.
 * Inside a Claude Code Routine it uses the routine's session credentials
 * (billed against the Max subscription's Agent SDK credit bucket as of
 * 2026-06-15). When run locally / outside a routine, falls back to
 * ANTHROPIC_API_KEY.
 *
 * Cwd: the spawned Claude session inherits `cwd` here, which the
 * routine-run script sets to the repo root. So `Read("src/lib/...")` etc
 * resolve against the real files.
 */
async function callOpus(systemPrompt: string, userContent: string, repoDir: string): Promise<ReasoningOutput | null> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // Force the SDK to use OAuth (Claude Code login → Max subscription
  // billing) instead of API-key billing. Without this, ANTHROPIC_API_KEY
  // in the env (used by sonnet-orchestrator-v2.ts and other modules)
  // would route the nested session through API metering. Scope is the
  // SDK call only — restored in finally so live orchestrator paths are
  // unaffected.
  //
  // To opt out and use API billing instead, set
  // AGENT_TODO_REASONING_FORCE_API=1 in the env.
  const forceApi = process.env.AGENT_TODO_REASONING_FORCE_API === "1";
  const savedKey = !forceApi ? process.env.ANTHROPIC_API_KEY : undefined;
  if (!forceApi) delete process.env.ANTHROPIC_API_KEY;

  const sdkSystemPrompt = `${systemPrompt}

Output protocol: you have Read, Glob, Grep, and Bash tools to explore the repo at ${repoDir}. Use them to ground EVERY file_path you propose. If you cannot verify a file exists, do not propose code_change-style todos against it — emit a sonnet_prompt with category="knowledge" instead.

When you are ready to propose, emit your final answer as a single JSON code block wrapped in \`\`\`json ... \`\`\`. The JSON MUST match this shape exactly:

{
  "decision": "no_action" | "customer_fix" | "system_gap" | "analysis_gap" | "escalation_false_positive",
  "context_what_happened": "one short paragraph",
  "context_what_we_propose": "one paragraph or short bullets",
  "urgency": "urgent" | "normal" | "low",
  "todos": [
    { "action_type": "...", "summary": "...", "payload": { ... }, "confidence": 0.0-1.0 }
  ]
}

Emit the JSON block as the LAST thing in your final response. After the JSON block, do not emit anything else.`;

  let finalText = "";
  try {
    const iter = query({
      prompt: userContent,
      options: {
        systemPrompt: sdkSystemPrompt,
        cwd: repoDir,
        model: OPUS_MODEL,
        allowedTools: ["Read", "Glob", "Grep", "Bash"],
        maxTurns: 30,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    });

    for await (const msg of iter) {
      // Capture every assistant text block; the JSON we want is in the last one.
      if (msg.type === "assistant" && (msg as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content) {
        const content = (msg as { message: { content: Array<{ type: string; text?: string }> } }).message.content;
        for (const block of content) {
          if (block.type === "text" && block.text) finalText = block.text;
        }
      }
    }
  } finally {
    if (!forceApi && savedKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedKey;
    }
  }

  if (!finalText) return null;

  // Extract JSON block from the final text.
  const fenced = finalText.match(/```json\s*\n([\s\S]*?)\n```/);
  const raw = fenced ? fenced[1] : (finalText.match(/\{[\s\S]*\}/)?.[0] ?? null);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as ReasoningOutput;
  } catch (err) {
    console.warn(`[reasoning] JSON parse failed: ${err instanceof Error ? err.message : err}. Raw: ${raw.slice(0, 300)}`);
    return null;
  }
}

/** Reason about a single ticket and (unless dryRun) write its todo group. */
export async function reasonAboutTicket(
  admin: Admin,
  opts: ReasoningOptions,
  ticketId: string,
): Promise<ReasoningResult> {
  try {
    const context = await gatherContext(admin, opts.workspaceId, ticketId);
    if (!context) return { ticketId, proposed: [], error: "ticket not found" };

    const userContent = [
      opts.brainBrief ? `BRAIN GUIDANCE:\n${opts.brainBrief}\n` : "",
      context,
    ].join("\n");

    const output = await callOpus(SYSTEM_PROMPT, userContent, opts.repoDir || process.cwd());
    if (!output || !output.todos?.length) {
      return { ticketId, proposed: [], skipped: "model proposed nothing" };
    }

    if (opts.dryRun) {
      return { ticketId, proposed: output.todos };
    }

    const groupId = randomUUID();
    const pre = await buildPreExecContext(admin, ticketId);
    const now = new Date().toISOString();
    const rows = output.todos.map((t) => ({
      workspace_id: opts.workspaceId,
      source: "ticket",
      source_ticket_id: ticketId,
      group_id: groupId,
      action_type: t.action_type,
      payload: t.payload || {},
      summary: t.summary,
      context_what_happened: output.context_what_happened,
      context_what_we_propose: output.context_what_we_propose,
      pre_exec_context: pre,
      confidence: typeof t.confidence === "number" ? t.confidence : null,
      urgency: t.urgency || output.urgency || "normal",
      status: "pending",
      routine_run_id: opts.routineRunId || null,
      created_at: now,
      updated_at: now,
    }));

    const { error } = await admin.from("agent_todos").insert(rows);
    if (error) return { ticketId, proposed: output.todos, error: error.message };

    return { ticketId, proposed: output.todos, groupId };
  } catch (err) {
    return { ticketId, proposed: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Run the reasoning pass across the workspace's escalated tickets. */
export async function runReasoningPass(opts: ReasoningOptions): Promise<ReasoningResult[]> {
  const admin = createAdminClient();
  const ticketIds = opts.ticketIds?.length
    ? opts.ticketIds
    : await findEscalatedNeedingTodos(admin, opts.workspaceId);

  const results: ReasoningResult[] = [];
  for (const ticketId of ticketIds) {
    // Re-check the active-group guard for non-backfill runs (another pass may
    // have proposed concurrently). Only ONE active group per ticket.
    if (!opts.dryRun) {
      const { data: existing } = await admin
        .from("agent_todos")
        .select("id")
        .eq("source_ticket_id", ticketId)
        .in("status", ["pending", "approved", "executed"])
        .limit(1);
      if (existing?.length) {
        results.push({ ticketId, proposed: [], skipped: "active group exists" });
        continue;
      }
    }
    results.push(await reasonAboutTicket(admin, opts, ticketId));
  }
  return results;
}
