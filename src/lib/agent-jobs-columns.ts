/**
 * agent_jobs — typed column source-of-truth for readers composing SELECTs.
 *
 * Why this file exists: agent_jobs is the build pipeline's core table and dozens of call sites
 * hand-roll raw `.select("col, col, …")` strings. When a select names a column that doesn't exist
 * (agent_jobs has `spec_branch` and `pending_actions` and NO `merge_sha`), Postgres raises 42703
 * and the Supabase client returns empty/undefined with no thrown error — the reader silently
 * degrades. This was live on `scripts/builder-worker.ts`: two selects requested a nonexistent
 * `merge_sha` column, so those reads returned undefined every run and the repeat-failure logic
 * silently no-op'd. Same class already bit other tables (specs-table, competitors, goals) — this
 * turns a wrong column into a tsc error at authoring time.
 *
 * Usage — import the readonly constant into your select composer, OR the helper:
 *
 *   import { AGENT_JOB_COLUMNS, jobSelect } from "@/lib/agent-jobs-columns";
 *   const { data } = await a.from("agent_jobs")
 *     .select(jobSelect("id", "kind", "spec_slug", "status", "pr_url", "spec_branch"))
 *     .eq(…);
 *
 * A future rename/typo (`agent_jobs.merge_shaa`, `agent_jobs.branch`) is a compile error because
 * `AgentJobColumn` is a union of the real column names. The drift test
 * (`agent-jobs-columns.test.ts`) additionally asserts this constant matches every column the
 * `supabase/migrations/*_agent_jobs*.sql` files define, so a migration adding a column without
 * updating this constant fails the test.
 */

/**
 * The REAL selectable columns of `public.agent_jobs`, verified against
 * `supabase/migrations/*_agent_jobs*.sql` and the live schema. Ordered by the migration ledger so
 * a diff of this list stays interpretable.
 *
 * NOTE: agent_jobs has NO `merge_sha`. The merge SHA lives on `spec_phases.merge_sha` /
 * `spec_status_history` — source it there if actually needed.
 */
export const AGENT_JOB_COLUMNS = [
  "id",
  "workspace_id",
  "spec_slug",
  "spec_branch",
  "instructions",
  "status",
  "claude_session_id",
  "questions",
  "answers",
  "pr_url",
  "pr_number",
  "log_tail",
  "error",
  "claimed_at",
  "created_by",
  "created_at",
  "updated_at",
  "pending_actions",
  "kind",
  "slack_notified_status",
  "chain_phases",
  "claude_session_config_dir",
  "needs_attention_class",
  "session_checklist",
  "session_note",
  "preview_url",
  "preview_state",
  "last_heartbeat_at",
  "reap_count",
  "metadata",
] as const;

export type AgentJobColumn = (typeof AGENT_JOB_COLUMNS)[number];

/**
 * Compose a typed SELECT string from an explicit column list. Each name is compile-checked against
 * the real `AgentJobColumn` union, so a typo (`.select(jobSelect("merge_sha"))`) is a tsc error,
 * not a silent-empty 42703 at runtime.
 */
export function jobSelect(...cols: AgentJobColumn[]): string {
  return cols.join(", ");
}
