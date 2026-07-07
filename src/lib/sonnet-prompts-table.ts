/**
 * sonnet-prompts-table — the typed read/write surface for `public.sonnet_prompts`
 * ([[../tables/sonnet_prompts]]).
 *
 * Phase 1 of docs/brain/specs/sonnet-prompts-sdk-for-review-agent-db-access.md. Mirrors the
 * ticket-analyses SDK ([[ticket-analyses-table]]) + the specs-table PM SDK ([[specs-table]]):
 * every write to the `sonnet_prompts` table goes through the narrow writers here
 * (`proposePrompt`, `applyReviewDecision`, `archiveSupersededPrompt`, `applyManualOverride`),
 * never a raw `.from('sonnet_prompts').insert(…)` / `.update(…)` in agent code. The static guard
 * `scripts/_check-sonnet-prompts-sdk-compliance.ts` scans `src/lib/**` + `src/app/**` +
 * `scripts/builder-worker.ts` and CI-red on any raw write outside the SDK.
 *
 * Design mirrors [[sonnet-prompt-auto-review]] `applyDecision`:
 *   - `applyReviewDecision` is the ONE writer for a review verdict — it maps decision → status +
 *     enabled + reviewed_at, and stamps ALL FIVE auto_decision columns together
 *     (auto_decision / auto_decision_at / auto_decision_reason / auto_decision_model /
 *     auto_decision_confidence). No caller can drift by writing four of the five, then a fifth
 *     from somewhere else — the SDK writes the full set atomically.
 *   - `archiveSupersededPrompt` archives the OLD row on a supersede verdict (superseded_by_id +
 *     status='archived' + enabled=false). Compare-and-set on `workspace_id` + `id` so a
 *     cross-workspace id sneak can never flip a foreign row.
 *   - `applyManualOverride` is the human override path (/api/sonnet-prompts/[id]/override):
 *     accept / reject / revert land the same auto_decision columns as the cron path, plus
 *     `reviewed_by` (only humans set that) and — on revert — clear the auto_decision + return
 *     status to 'proposed'.
 *   - `proposePrompt` is the proposal insert helper — same shape every proposer uses (daily
 *     report, playbook-compiler, ticket-improve action, escalation-triage triage-todo,
 *     CS-director digest reply).
 *
 * Reads (`getProposal`, `listProposed`) are exposed too so callers can drop their raw
 * `.from('sonnet_prompts').select(…)` chains in one migration; the guard is write-only (mirrors
 * the ticket-analyses / PM SDK's WRITE_VERBS scope).
 *
 * Service-role only — all callers go through `createAdminClient()`. Never client-side.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient<any, any, any>;

/**
 * The `sonnet_prompts.status` enum, per [[../tables/sonnet_prompts]] § Columns. `archived` is what
 * the supersede lane lands the OLD row in (kept, not deleted — reversible).
 */
export type PromptStatus = "proposed" | "approved" | "rejected" | "archived";

/**
 * The `sonnet_prompts.auto_decision` enum. `human_review` is in the historical enum but the cron
 * never emits it (downgraded to `reject` since 2026-06-03 — see the applyDecision REJECT_FLOOR /
 * ACCEPT_FLOOR gates in [[sonnet-prompt-auto-review]]). Included here so `applyManualOverride`'s
 * revert path can still write it as an audit crumb without a cast.
 */
export type AutoDecision = "accept" | "reject" | "merge" | "supersede" | "revise" | "human_review";

/** The category enum, per [[../tables/sonnet_prompts]] § Gotchas. */
export type PromptCategory = "rule" | "approach" | "knowledge" | "tool_hint" | "personality";

/** Minimal projection every caller reads today. Callers passing a wider `select` get `Record<string, unknown>`. */
export interface SonnetPromptRow {
  id: string;
  workspace_id: string;
  category: string;
  title: string;
  content: string;
  status: PromptStatus;
  enabled: boolean;
  auto_decision: AutoDecision | null;
  auto_decision_confidence: number | null;
  source_pattern_id: string | null;
  derived_from_ticket_id: string | null;
}

/**
 * Reason string truncation. The `sonnet_prompts.auto_decision_reason` column carries a brief
 * reasoning surface (the full per-decision history lives in [[../tables/sonnet_prompt_decisions]]).
 * Every SDK writer clips reasoning to this bound so a caller cannot silently drift by writing an
 * un-clipped reasoning field.
 */
const REASON_CHAR_CAP = 2000;

// ── Reads ──────────────────────────────────────────────────────────

export interface GetProposalOpts {
  /** Column list. Defaults to the shape the box worker's runPromptReviewJob pre-flight needs. */
  select?: string;
}

/**
 * Fetch ONE proposed prompt by id, scoped to a workspace. Used by the box worker's
 * runPromptReviewJob pre-flight check ([[../inngest/sonnet-prompt-auto-review]] flow) to bail
 * cleanly when a proposal was already decided (via manual override or a duplicate cron run).
 * Returns `null` when the row is missing — the caller distinguishes "no-op" from a DB error via
 * the `error` field.
 */
export async function getProposal(
  admin: Admin,
  workspaceId: string,
  proposalId: string,
  opts?: GetProposalOpts,
): Promise<{ row: Record<string, unknown> | null; error: string | null }> {
  const select =
    opts?.select ??
    "id, workspace_id, title, content, category, source_pattern_id, derived_from_ticket_id, status, auto_decision";
  const { data, error } = await admin
    .from("sonnet_prompts")
    .select(select)
    .eq("id", proposalId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: (data as Record<string, unknown> | null) ?? null, error: null };
}

export interface ListProposedOpts {
  /** Ordering hint. Defaults to `proposed_at ASC` (oldest first — matches the cron sweep). */
  order?: "asc" | "desc";
  /** Row limit. Defaults to the cron's per-tick cap (50). */
  limit?: number;
  select?: string;
}

/**
 * List a workspace's `status='proposed' AND auto_decision IS NULL` prompts — the cron's daily
 * backlog. The Inngest enqueue cron reads this shape today
 * ([[../inngest/sonnet-prompt-auto-review]]); exposed here so a future cron migration can drop the
 * raw select without changing behavior.
 */
export async function listProposed(
  admin: Admin,
  workspaceId: string,
  opts?: ListProposedOpts,
): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  const select = opts?.select ?? "id";
  const { data, error } = await admin
    .from("sonnet_prompts")
    .select(select)
    .eq("workspace_id", workspaceId)
    .eq("status", "proposed")
    .is("auto_decision", null)
    .order("proposed_at", { ascending: (opts?.order ?? "asc") === "asc" })
    .limit(opts?.limit ?? 50);
  if (error) return { rows: [], error: error.message };
  return { rows: (data as unknown as Record<string, unknown>[] | null) ?? [], error: null };
}

// ── Writes ─────────────────────────────────────────────────────────

export interface ProposePromptInput {
  workspaceId: string;
  title: string;
  content: string;
  /** Defaults to `'rule'`. Every proposer today emits `'rule'` — the enum is defensive. */
  category?: PromptCategory | string;
  /** When set, mirrors the source-ticket-derivation FK for a ticket-proposed rule. */
  derivedFromTicketId?: string | null;
  /** When set, mirrors the daily-analysis-report FK the proposal was surfaced from. */
  sourcePatternId?: string | null;
  /** Defaults to `false` — proposals never ship enabled; they enable on `accept`. */
  enabled?: boolean;
  /** Defaults to `200` — the shared sort_order proposers use so admin CRUD rows sort above. */
  sortOrder?: number;
  /** ISO stamp. Defaults to `new Date().toISOString()`. */
  proposedAt?: string;
}

/**
 * Insert one PROPOSAL row (`status='proposed'`, `enabled=false`, `proposed_at=now`). The ONE
 * writer every proposer routes through: the daily-analysis report ([[daily-analysis-report]]), the
 * playbook-compiler ([[playbook-compiler]]), the ticket-improve action dispatcher
 * ([[improve-actions]]), the escalation-triage triage-todo materializer
 * ([[agent-todos/triage]]), and the CS-director digest reply ([[cs-director-digest-reply]]).
 *
 * Returns `{ id, error }`. On error, `id` is `null` and the caller logs the error string.
 */
export async function proposePrompt(
  admin: Admin,
  input: ProposePromptInput,
): Promise<{ id: string | null; error: string | null }> {
  const row: Record<string, unknown> = {
    workspace_id: input.workspaceId,
    title: input.title,
    content: input.content,
    category: input.category ?? "rule",
    enabled: input.enabled ?? false,
    status: "proposed",
    proposed_at: input.proposedAt ?? new Date().toISOString(),
    sort_order: input.sortOrder ?? 200,
  };
  if (input.derivedFromTicketId) row.derived_from_ticket_id = input.derivedFromTicketId;
  if (input.sourcePatternId) row.source_pattern_id = input.sourcePatternId;

  const { data, error } = await admin
    .from("sonnet_prompts")
    .insert(row)
    .select("id")
    .single();
  if (error) return { id: null, error: error.message };
  return { id: (data as { id: string } | null)?.id ?? null, error: null };
}

export interface ApplyReviewDecisionInput {
  workspaceId: string;
  promptId: string;
  /** The FINAL decision the caller landed on (post safety gates — accept / reject / merge / supersede / revise). */
  finalDecision: AutoDecision;
  /** The raw reasoning surface. Auto-clipped to 2000 chars by the SDK. */
  reasoning: string;
  /** The raw model confidence (0..1). NOT floor-adjusted; the safety-downgrade is the caller's job. */
  confidence: number;
  /** The model id, or `'manual_override'` for the override lane. */
  model: string;
  /** For a `merge` decision — the canonical rule the proposal folded into. */
  mergeTargetId?: string | null;
  /** For a `supersede` decision — the OLD rule the proposal replaces (also archived via `archiveSupersededPrompt`). */
  supersedeTargetId?: string | null;
  /** ISO stamp for `auto_decision_at`. Defaults to `new Date().toISOString()`. */
  decidedAt?: string;
}

/**
 * Apply a review verdict to a proposed prompt — the ONE writer that stamps ALL FIVE auto_decision
 * columns + status + enabled + reviewed_at in one call. Called by the box's `applyDecision`
 * ([[sonnet-prompt-auto-review]]) after safety gates have resolved the FINAL decision.
 *
 * Decision → row shape:
 *   - `accept`    → status='approved',  enabled=true,  reviewed_at set
 *   - `reject`    → status='rejected',  enabled=false, reviewed_at set
 *   - `merge`     → status='rejected',  enabled=false, merged_into_id set, reviewed_at set
 *   - `supersede` → status='approved',  enabled unchanged, reviewed_at set (call `archiveSupersededPrompt` on the OLD row)
 *   - `revise`    → status='proposed',  suggested_revisions live on the audit row (no shape change here)
 *   - `human_review` → NEVER written by the cron (auto-downgrades to reject). Callable ONLY by the
 *      manual override path — for the manual path use `applyManualOverride` instead.
 *
 * Compare-and-set on `workspace_id` + `id`. `.select("id")` asserts exactly one row transitioned;
 * `{ ok:false, error:'rows=0' }` if a concurrent decision already landed (the pre-flight check
 * in the box worker verified `status='proposed' AND auto_decision IS NULL` — this SDK doesn't
 * re-verify the pre-condition because the caller may re-run under an audit-first re-decision).
 */
export async function applyReviewDecision(
  admin: Admin,
  input: ApplyReviewDecisionInput,
): Promise<{ ok: boolean; error: string | null }> {
  if (input.finalDecision === "merge" && !input.mergeTargetId) {
    return { ok: false, error: "applyReviewDecision: merge decision requires mergeTargetId" };
  }
  if (input.finalDecision === "supersede" && !input.supersedeTargetId) {
    return { ok: false, error: "applyReviewDecision: supersede decision requires supersedeTargetId" };
  }

  const nowIso = input.decidedAt ?? new Date().toISOString();
  const updates: Record<string, unknown> = {
    auto_decision: input.finalDecision,
    auto_decision_at: nowIso,
    auto_decision_reason: (input.reasoning ?? "").slice(0, REASON_CHAR_CAP),
    auto_decision_model: input.model,
    auto_decision_confidence: input.confidence,
  };

  switch (input.finalDecision) {
    case "accept":
      // NOTE: the pre-SDK auto-review path (`applyDecision` in [[sonnet-prompt-auto-review]]) did
      // NOT stamp `enabled=true` here — an accepted proposal lands with `status='approved'` but
      // `enabled=false` (inherited from the proposal insert), so an admin must flip it live from
      // /dashboard/settings/ai/prompts. Preserved here so the SDK migration is behavior-preserving.
      // The [[../tables/sonnet_prompts]] brain page's auto-decision lifecycle diagram shows
      // `enabled=true` on accept; that's a doc/code drift older than this SDK — a follow-up spec
      // can align the two, but this Phase 1 migration is a no-behavior-change routing pass.
      updates.status = "approved";
      updates.reviewed_at = nowIso;
      break;
    case "reject":
      updates.status = "rejected";
      updates.enabled = false;
      updates.reviewed_at = nowIso;
      break;
    case "merge":
      updates.status = "rejected";
      updates.enabled = false;
      updates.merged_into_id = input.mergeTargetId;
      updates.reviewed_at = nowIso;
      break;
    case "supersede":
      // NEW proposal lands `status='approved'` + `reviewed_at`. `enabled` untouched (matches the
      // pre-SDK behavior — the same doc/code drift as `accept`). The OLD row's archive
      // (`superseded_by_id` + `enabled=false` + `status='archived'`) lives in `archiveSupersededPrompt`.
      updates.status = "approved";
      updates.reviewed_at = nowIso;
      break;
    case "revise":
      updates.status = "proposed";
      break;
    case "human_review":
      // Cron never emits this — kept only as a defensive branch. No status/enabled write; the
      // audit row carries the intent + the reason string tells a supervisor why we routed here.
      break;
  }

  const { data, error } = await admin
    .from("sonnet_prompts")
    .update(updates)
    .eq("id", input.promptId)
    .eq("workspace_id", input.workspaceId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  const rows = (data as { id: string }[] | null) ?? [];
  if (rows.length !== 1) {
    return { ok: false, error: `applyReviewDecision: ${rows.length} rows transitioned (expected 1)` };
  }
  return { ok: true, error: null };
}

export interface ArchiveSupersededInput {
  workspaceId: string;
  /** The OLD prompt being replaced. */
  oldPromptId: string;
  /** The NEW prompt that supersedes it. */
  newPromptId: string;
}

/**
 * Archive the OLD row on a supersede verdict. Sets `superseded_by_id`, `enabled=false`, and
 * `status='archived'`. Never deletes — a supersede is reversible (the archived row is preserved).
 * Called by [[sonnet-prompt-auto-review]] `applyDecision` right after `applyReviewDecision` on the
 * NEW proposal lands. Compare-and-set on `workspace_id` + `id`.
 */
export async function archiveSupersededPrompt(
  admin: Admin,
  input: ArchiveSupersededInput,
): Promise<{ ok: boolean; error: string | null }> {
  const { data, error } = await admin
    .from("sonnet_prompts")
    .update({
      superseded_by_id: input.newPromptId,
      enabled: false,
      status: "archived",
    })
    .eq("id", input.oldPromptId)
    .eq("workspace_id", input.workspaceId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  const rows = (data as { id: string }[] | null) ?? [];
  if (rows.length !== 1) {
    return { ok: false, error: `archiveSupersededPrompt: ${rows.length} rows transitioned (expected 1)` };
  }
  return { ok: true, error: null };
}

export type ManualOverrideAction = "accept" | "reject" | "revert";

export interface ApplyManualOverrideInput {
  workspaceId: string;
  promptId: string;
  action: ManualOverrideAction;
  /** The human's `auth.users.id` — stamped on `reviewed_by`. */
  actor: string;
  /** Short reason prefix (e.g. `"[manual_override:accept] by <user-id>"`). Auto-clipped to 2000 chars. */
  reasonPrefix: string;
}

/**
 * Human override of an auto-decision. Called by /api/sonnet-prompts/[id]/override.
 *
 * Action → row shape:
 *   - `accept`  → status='approved',  enabled=true,  auto_decision='accept', reviewed_at + reviewed_by set
 *   - `reject`  → status='rejected',  enabled=false, auto_decision='reject', reviewed_at + reviewed_by set
 *   - `revert`  → status='proposed',  enabled=true,  auto_decision=NULL,    reviewed_at cleared
 *
 * `auto_decision_model` is always `'manual_override'` (the audit surface distinguishes cron
 * verdicts from human overrides on the /dashboard/ai-analysis Auto-decisions tab).
 * Compare-and-set on `workspace_id` + `id`.
 */
export async function applyManualOverride(
  admin: Admin,
  input: ApplyManualOverrideInput,
): Promise<{ ok: boolean; error: string | null }> {
  const nowIso = new Date().toISOString();
  const updates: Record<string, unknown> = {
    auto_decision_at: nowIso,
    auto_decision_model: "manual_override",
    auto_decision_reason: (input.reasonPrefix ?? "").slice(0, REASON_CHAR_CAP),
  };
  switch (input.action) {
    case "accept":
      updates.auto_decision = "accept";
      updates.status = "approved";
      updates.enabled = true;
      updates.reviewed_at = nowIso;
      updates.reviewed_by = input.actor;
      break;
    case "reject":
      updates.auto_decision = "reject";
      updates.status = "rejected";
      updates.enabled = false;
      updates.reviewed_at = nowIso;
      updates.reviewed_by = input.actor;
      break;
    case "revert":
      updates.auto_decision = null;
      updates.status = "proposed";
      updates.enabled = true;
      updates.reviewed_at = null;
      break;
  }
  const { data, error } = await admin
    .from("sonnet_prompts")
    .update(updates)
    .eq("id", input.promptId)
    .eq("workspace_id", input.workspaceId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  const rows = (data as { id: string }[] | null) ?? [];
  if (rows.length !== 1) {
    return { ok: false, error: `applyManualOverride: ${rows.length} rows transitioned (expected 1)` };
  }
  return { ok: true, error: null };
}
