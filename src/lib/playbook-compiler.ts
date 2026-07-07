/**
 * Playbook compiler — mines ticket_resolution_events for recurring
 * problem × resolution patterns and proposes new playbook-shaped rules
 * via the existing sonnet_prompts approval queue.
 *
 * Phase 1 of the playbook-compiler loop (M4 of the guaranteed-ticket-
 * handling goal). Runs weekly via
 * src/lib/inngest/playbook-compiler.ts; extracted here so the cron
 * stays a thin wrapper and the mining/drafting logic is testable in
 * isolation.
 *
 * Loop:
 *   1. Read ticket_resolution_events over the last 30 days where
 *      verified_outcome='confirmed' (the turns the orchestrator
 *      actually got right).
 *   2. Bucket by (problem, resolution shape). The resolution shape is
 *      the action_shape.type on options[chosen.option_index] — the
 *      handler the model actually chose, canonicalized so
 *      `refund` + `refund` cluster together even when the amount /
 *      order_id fields differ. When the model returned multiple
 *      actions on the shape (e.g. `replacement + partial_refund`), we
 *      key the cluster on the sorted action-type tuple so both
 *      actions surface together in the proposed rule.
 *   3. Pattern clusters with support >= SUPPORT_MIN (default 15,
 *      overridable per-workspace on
 *      `workspaces.playbook_compiler_support_min`) are eligible for
 *      drafting.
 *   4. Skip clusters whose problem already anchors an approved / open
 *      sonnet_prompts rule (title match — same dedupe as the
 *      daily-analysis-report loop uses).
 *   5. For each remaining cluster, call Sonnet to draft a playbook-
 *      shaped natural-language rule (`when X → do Y`).
 *   6. Insert one `sonnet_prompts` row per draft, mirroring the
 *      daily-analysis-report insert shape
 *      (src/lib/daily-analysis-report.ts:170) — `category='rule'`,
 *      `status='proposed'`, `enabled=false`,
 *      `proposed_at=now()`, `sort_order=200`. The row surfaces on
 *      /dashboard/settings/ai/prompts with Approve/Decline buttons
 *      (the existing queue); on approval it flips
 *      `status='approved', enabled=true` and the next
 *      unified-ticket-handler run picks it up in the concatenated
 *      system prompt.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAiUsage, usageCostCents } from "@/lib/ai-usage";
import { SONNET_MODEL } from "@/lib/ai-models";
import { proposePrompt } from "@/lib/sonnet-prompts-table";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DRAFT_MODEL = SONNET_MODEL;

/** Default support threshold — cluster needs >= this many confirmed turns to draft. */
export const DEFAULT_SUPPORT_MIN = 15;

/** Mining window in days — matches spec Phase 1. */
export const MINING_WINDOW_DAYS = 30;

interface ResolutionRow {
  id: string;
  ticket_id: string;
  problem: string | null;
  options: unknown;
  chosen: unknown;
  verified_outcome: string | null;
  staged_at: string;
}

export interface Cluster {
  /** Normalized diagnosis (SonnetDecision.problem, lowercased + trimmed). */
  problem: string;
  /** Sorted action-shape type tuple, e.g. ["partial_refund","replacement"]. */
  actionTypes: string[];
  /** Human-readable cluster key `problem :: type_a+type_b` — used for dedupe / logging. */
  key: string;
  /** Distinct ticket_id count — the "support" of the pattern. */
  support: number;
  /** Sample ticket ids (up to 5) — passed to Sonnet as evidence. */
  sampleTicketIds: string[];
}

export interface CompileResult {
  /** Number of confirmed rows read for this workspace. */
  rowsRead: number;
  /** All clusters (any support). */
  clusters: number;
  /** Clusters meeting the support threshold. */
  eligible: number;
  /** Clusters already covered by an existing sonnet_prompts title. */
  dedupedAgainstExisting: number;
  /** sonnet_prompts rows inserted. */
  drafted: number;
  /** The inserted sonnet_prompts.id values. */
  proposedSonnetIds: string[];
  /** Why we bailed early (if applicable). */
  reason?: string;
}

/**
 * Extract the resolution shape from a ticket_resolution_events row.
 *
 * `options` is an array of `{label, action_shape, expected_effect}`;
 * `chosen.option_index` indexes into it. `action_shape` can be a
 * single action-shape object OR an array of them (the orchestrator
 * sometimes bundles a replacement + partial_refund into one option).
 * We return the sorted list of `.type` strings so multi-action shapes
 * cluster on the tuple.
 */
export function extractActionTypes(options: unknown, chosen: unknown): string[] {
  if (!Array.isArray(options)) return [];
  if (!chosen || typeof chosen !== "object") return [];
  const optionIndex = (chosen as { option_index?: unknown }).option_index;
  if (typeof optionIndex !== "number" || !Number.isInteger(optionIndex)) return [];
  if (optionIndex < 0 || optionIndex >= options.length) return [];
  const picked = options[optionIndex];
  if (!picked || typeof picked !== "object") return [];
  const shape = (picked as { action_shape?: unknown }).action_shape;
  const types: string[] = [];
  const walk = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== "object") return;
    const t = (node as { type?: unknown }).type;
    if (typeof t === "string" && t.length > 0) types.push(t);
  };
  walk(shape);
  // Dedupe + stable-sort so `replacement + partial_refund` and
  // `partial_refund + replacement` land in the same cluster.
  return Array.from(new Set(types)).sort();
}

/**
 * Bucket confirmed resolution rows into (problem, actionTypes) clusters.
 *
 * Rows missing problem or with no derivable actionTypes are dropped —
 * they can't participate in a "when X → do Y" rule.
 *
 * Support is counted per-ticket (a two-turn ticket with the same
 * problem×action doesn't double-count) — the pattern is "N distinct
 * tickets landed here", not "N turns".
 */
export function bucketClusters(rows: ResolutionRow[]): Cluster[] {
  const map = new Map<string, {
    problem: string;
    actionTypes: string[];
    tickets: Set<string>;
    samples: string[];
  }>();

  for (const row of rows) {
    const problem = (row.problem || "").trim().toLowerCase();
    if (!problem) continue;
    const actionTypes = extractActionTypes(row.options, row.chosen);
    if (actionTypes.length === 0) continue;
    const key = `${problem} :: ${actionTypes.join("+")}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { problem, actionTypes, tickets: new Set(), samples: [] };
      map.set(key, bucket);
    }
    bucket.tickets.add(row.ticket_id);
    if (bucket.samples.length < 5 && !bucket.samples.includes(row.ticket_id)) {
      bucket.samples.push(row.ticket_id);
    }
  }

  const out: Cluster[] = [];
  for (const [key, bucket] of map) {
    out.push({
      problem: bucket.problem,
      actionTypes: bucket.actionTypes,
      key,
      support: bucket.tickets.size,
      sampleTicketIds: bucket.samples,
    });
  }
  // Highest-support first — makes cron logs easier to read + gives Sonnet the
  // hottest patterns first when we cap the per-run draft count.
  out.sort((a, b) => b.support - a.support);
  return out;
}

/**
 * Build the title we insert into sonnet_prompts + the dedupe key we
 * compare against existing rules. Kept deterministic so a re-run
 * against unchanged data doesn't propose a second copy.
 */
export function draftTitle(cluster: Cluster): string {
  const actions = cluster.actionTypes.join(" + ");
  return `Playbook rule — ${cluster.problem} → ${actions}`;
}

function buildDraftSystemPrompt(): string {
  return `You are drafting a customer-service rule for a Sonnet orchestrator.

Return ONE JSON object of the shape:
{
  "title": "one-line title, e.g. 'When customer reports melted_in_transit → replacement + partial_refund'",
  "body": "3-6 sentence rule in the orchestrator's voice — when the described customer situation matches, do the described action(s). Name every action explicitly. Reference no ticket ids. No markdown."
}

Ground rules:
- The body is injected into the orchestrator's system prompt at runtime, so it must read as an INSTRUCTION, not a description.
- Prefer imperative voice ("If the customer reports X, offer Y and Z.").
- Name every action in the actionTypes list — do NOT collapse "replacement + partial_refund" to just "replacement".
- Do not invent a policy the actions don't already imply.
- No greetings, no signatures, no code fences.`;
}

function buildDraftUserMessage(cluster: Cluster): string {
  return `A pattern surfaced across ${cluster.support} confirmed ticket resolutions in the last ${MINING_WINDOW_DAYS} days:

problem: ${cluster.problem}
resolution actions taken (in the order the orchestrator returned them): ${cluster.actionTypes.join(", ")}
sample ticket ids (evidence, do not cite): ${cluster.sampleTicketIds.join(", ")}

Draft the playbook-shaped rule.`;
}

interface DraftOutput {
  title: string;
  body: string;
}

function parseDraftOutput(text: string): DraftOutput | null {
  // Sonnet occasionally wraps the object in fences or trailing prose — extract
  // the first {...} block and JSON.parse it.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  const slice = text.slice(first, last + 1);
  try {
    const parsed = JSON.parse(slice);
    if (typeof parsed?.title !== "string" || typeof parsed?.body !== "string") return null;
    const title = parsed.title.trim();
    const body = parsed.body.trim();
    if (!title || !body) return null;
    return { title, body };
  } catch {
    return null;
  }
}

/**
 * Call Sonnet to draft a rule for one cluster. Isolated so the
 * cron can page through many clusters without one bad response
 * killing the batch. Returns null on any API / parse failure —
 * caller logs + moves on.
 */
export async function draftRule(
  workspaceId: string,
  cluster: Cluster,
): Promise<{ draft: DraftOutput | null; usage: Record<string, unknown> | null }> {
  if (!ANTHROPIC_API_KEY) return { draft: null, usage: null };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: DRAFT_MODEL,
      max_tokens: 800,
      system: buildDraftSystemPrompt(),
      messages: [{ role: "user", content: buildDraftUserMessage(cluster) }],
    }),
  });

  if (!res.ok) {
    console.warn("[playbook-compiler] sonnet call failed:", res.status);
    return { draft: null, usage: null };
  }

  const data = await res.json();
  const usage = data?.usage || null;

  await logAiUsage({
    workspaceId,
    model: DRAFT_MODEL,
    usage,
    purpose: "playbook_compiler_draft",
    ticketId: null,
  });

  const text = (data?.content?.[0]?.text || "").trim();
  const draft = parseDraftOutput(text);
  if (!draft) {
    console.warn("[playbook-compiler] parse failed for cluster", cluster.key, text.slice(0, 200));
    return { draft: null, usage };
  }
  return { draft, usage };
}

/**
 * Read the per-workspace support threshold if the workspace pinned
 * one (workspaces.playbook_compiler_support_min), else the default.
 * Missing column or missing row → default.
 */
async function loadSupportMin(admin: SupabaseClient, workspaceId: string): Promise<number> {
  try {
    const { data } = await admin
      .from("workspaces")
      .select("playbook_compiler_support_min")
      .eq("id", workspaceId)
      .maybeSingle();
    const raw = (data as { playbook_compiler_support_min?: unknown } | null)?.playbook_compiler_support_min;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  } catch {
    // column may not exist yet — the compiler falls back to the default.
  }
  return DEFAULT_SUPPORT_MIN;
}

/**
 * Mine + draft + insert for one workspace.
 *
 * Never throws — a failure at any stage returns `ok=false` with a
 * reason so the cron can keep sweeping siblings.
 */
export async function compileForWorkspace(workspaceId: string): Promise<CompileResult> {
  const admin = createAdminClient();
  return compileForWorkspaceWithClient(admin, workspaceId);
}

export async function compileForWorkspaceWithClient(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<CompileResult> {
  const supportMin = await loadSupportMin(admin, workspaceId);
  const windowStart = new Date(Date.now() - MINING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: rowsRaw, error: rowsErr } = await admin
    .from("ticket_resolution_events")
    .select("id, ticket_id, problem, options, chosen, verified_outcome, staged_at")
    .eq("workspace_id", workspaceId)
    .eq("verified_outcome", "confirmed")
    .gte("staged_at", windowStart);

  if (rowsErr) {
    console.error("[playbook-compiler] rows read failed:", rowsErr.message);
    return {
      rowsRead: 0,
      clusters: 0,
      eligible: 0,
      dedupedAgainstExisting: 0,
      drafted: 0,
      proposedSonnetIds: [],
      reason: `rows_read_failed_${rowsErr.code || "unknown"}`,
    };
  }

  const rows = (rowsRaw || []) as ResolutionRow[];
  if (rows.length === 0) {
    return {
      rowsRead: 0,
      clusters: 0,
      eligible: 0,
      dedupedAgainstExisting: 0,
      drafted: 0,
      proposedSonnetIds: [],
      reason: "no_confirmed_rows",
    };
  }

  const allClusters = bucketClusters(rows);
  const eligible = allClusters.filter((c) => c.support >= supportMin);

  if (eligible.length === 0) {
    return {
      rowsRead: rows.length,
      clusters: allClusters.length,
      eligible: 0,
      dedupedAgainstExisting: 0,
      drafted: 0,
      proposedSonnetIds: [],
      reason: `no_cluster_over_support_min_${supportMin}`,
    };
  }

  // Dedupe against existing sonnet_prompts titles the compiler previously
  // proposed / an admin already approved — matches the daily-analysis-report
  // dedupe pattern (src/lib/daily-analysis-report.ts § "Pull existing rules
  // so Opus doesn't propose duplicates").
  const { data: existing } = await admin
    .from("sonnet_prompts")
    .select("title")
    .eq("workspace_id", workspaceId)
    .in("status", ["approved", "proposed"]);
  const existingTitles = new Set<string>();
  for (const r of existing || []) {
    if (typeof (r as { title?: unknown }).title === "string") {
      existingTitles.add((r as { title: string }).title.toLowerCase());
    }
  }

  const toDraft: Cluster[] = [];
  let deduped = 0;
  for (const cluster of eligible) {
    if (existingTitles.has(draftTitle(cluster).toLowerCase())) {
      deduped++;
      continue;
    }
    toDraft.push(cluster);
  }

  if (!ANTHROPIC_API_KEY) {
    return {
      rowsRead: rows.length,
      clusters: allClusters.length,
      eligible: eligible.length,
      dedupedAgainstExisting: deduped,
      drafted: 0,
      proposedSonnetIds: [],
      reason: "no_api_key",
    };
  }

  const proposedSonnetIds: string[] = [];
  let drafted = 0;

  for (const cluster of toDraft) {
    const { draft, usage } = await draftRule(workspaceId, cluster);
    if (!draft) continue;

    if (usage) {
      const inputTokens = (usage.input_tokens as number) || 0;
      const outputTokens = (usage.output_tokens as number) || 0;
      const costCents = usageCostCents(DRAFT_MODEL, {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_tokens: (usage.cache_creation_input_tokens as number) || 0,
        cache_read_tokens: (usage.cache_read_input_tokens as number) || 0,
      });
      // Cost logged into ai_token_usage already via logAiUsage — this
      // trace line is diagnostic so a cron sweep can be triaged from
      // the logs alone.
      console.log(`[playbook-compiler] drafted "${cluster.key}" support=${cluster.support} cost=${costCents.toFixed(4)}c`);
    }

    // sonnet-prompts-sdk-for-review-agent-db-access Phase 1 — proposal inserts route through the
    // sonnet-prompts SDK ([[sonnet-prompts-table]]).
    const { id, error } = await proposePrompt(admin, {
      workspaceId,
      title: draftTitle(cluster),
      content: draft.body,
      category: "rule",
    });
    if (error) {
      console.warn("[playbook-compiler] sonnet_prompts insert failed:", error);
      continue;
    }
    if (id) {
      proposedSonnetIds.push(id);
      drafted++;
    }
  }

  return {
    rowsRead: rows.length,
    clusters: allClusters.length,
    eligible: eligible.length,
    dedupedAgainstExisting: deduped,
    drafted,
    proposedSonnetIds,
  };
}
