/**
 * Agent To-Do system — execution of SYSTEM-level todos.
 *
 * Runs ONLY inside the Claude Code Routine (it shells out to git/gh and needs
 * the repo checked out). Never imported by Vercel serverless code.
 *
 * DB-only actions (sonnet_prompt_*, ticket_analysis_rescore) write straight to
 * Supabase. PR actions (brain_doc_edit, code_change, grader_prompt_edit,
 * escalation_rule_fix) apply the payload to the working tree, run the CI gate
 * (`npx tsc --noEmit`), and — only if green — branch + commit + push + open a PR
 * on a claude/-prefixed branch. If CI fails, no PR opens and the todo is failed
 * with the compile error captured.
 *
 * Safety invariants enforced here:
 *   - code_change NEVER auto-merges (hard-coded).
 *   - brain_doc_edit auto-merges only when payload.auto_merge === true.
 *   - CI gate runs BEFORE push; broken branches never reach GitHub.
 *
 * See docs/brain/specs/agent-todo-system.md § Phase 1 step 2 + Phase 4.7.
 */
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentTodo, ExecutionResult } from "./types";

type Admin = ReturnType<typeof createAdminClient>;

export interface SystemExecOptions {
  repoDir: string; // absolute path to the cloned repo
  repo?: string; // owner/name for gh; defaults to AGENT_TODO_REPO
}

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

// ── DB-only actions ─────────────────────────────────────────────────────────

async function execSonnetPrompt(admin: Admin, todo: AgentTodo): Promise<ExecutionResult> {
  const p = todo.payload as { title?: string; category?: string; content?: string; target_prompt_id?: string };
  if (todo.action_type === "sonnet_prompt_edit" && p.target_prompt_id) {
    const { error } = await admin
      .from("sonnet_prompts")
      .update({ title: p.title, category: p.category, content: p.content, updated_at: new Date().toISOString() })
      .eq("id", p.target_prompt_id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, row_id: p.target_prompt_id };
  }
  const { data, error } = await admin
    .from("sonnet_prompts")
    .insert({
      workspace_id: todo.workspace_id,
      title: p.title || todo.summary,
      category: p.category || "rule",
      content: p.content || "",
      enabled: true,
      status: "approved",
      proposed_at: new Date().toISOString(),
      sort_order: 200,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, row_id: data.id };
}

async function execAnalysisRescore(admin: Admin, todo: AgentTodo): Promise<ExecutionResult> {
  const p = todo.payload as { ticket_analysis_id?: string; score?: number; summary?: string; issues?: unknown };
  if (!p.ticket_analysis_id) return { ok: false, error: "missing ticket_analysis_id" };
  const { error } = await admin
    .from("ticket_analyses")
    .update({
      admin_score: p.score,
      admin_score_reason: "Rescored by To-Do routine (approved)",
      admin_corrected_at: new Date().toISOString(),
      summary: p.summary,
      issues: p.issues ?? undefined,
    })
    .eq("id", p.ticket_analysis_id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, row_id: p.ticket_analysis_id };
}

// ── PR actions ──────────────────────────────────────────────────────────────

function applyPayloadToTree(repoDir: string, todo: AgentTodo): string {
  const p = todo.payload as { file_path?: string; unified_diff?: string; new_file_body?: string };
  if (p.unified_diff) {
    const patchFile = join(repoDir, `.agent-todo-${todo.id}.patch`);
    writeFileSync(patchFile, p.unified_diff.endsWith("\n") ? p.unified_diff : p.unified_diff + "\n");
    try {
      sh(`git apply --whitespace=nowarn "${patchFile}"`, repoDir);
    } finally {
      sh(`rm -f "${patchFile}"`, repoDir);
    }
    return p.file_path || "(diff)";
  }
  if (p.file_path && p.new_file_body !== undefined) {
    const abs = join(repoDir, p.file_path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, p.new_file_body);
    return p.file_path;
  }
  throw new Error("PR payload needs unified_diff or (file_path + new_file_body)");
}

async function execPrAction(todo: AgentTodo, opts: SystemExecOptions): Promise<ExecutionResult> {
  const repoDir = opts.repoDir;
  const repo = opts.repo || process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";

  // Start clean on the default branch.
  sh(`git checkout -- . || true`, repoDir);
  const branch = `claude/agent-todo-${slug(todo.summary) || todo.action_type}-${randomUUID().slice(0, 8)}`;
  sh(`git checkout -b "${branch}"`, repoDir);

  let touched: string;
  try {
    touched = applyPayloadToTree(repoDir, todo);
  } catch (err) {
    sh(`git checkout - && git branch -D "${branch}" || true`, repoDir);
    return { ok: false, error: `apply failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // CI gate — typecheck BEFORE pushing. No broken branches reach GitHub.
  try {
    sh(`npx tsc --noEmit`, repoDir);
  } catch (err) {
    const out = (err as { stdout?: string; stderr?: string }).stdout || (err as { stderr?: string }).stderr || String(err);
    sh(`git checkout -- . && git checkout - && git branch -D "${branch}" || true`, repoDir);
    return { ok: false, error: `CI gate (tsc) failed:\n${out}`.slice(0, 4000) };
  }

  // Commit + push + open PR.
  const title = todo.summary.slice(0, 70);
  const body = [
    `Proposed by the Agent To-Do routine and approved by ${todo.approval_role || "owner"}.`,
    "",
    todo.context_what_we_propose || "",
    "",
    `Todo: ${todo.id}`,
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n");

  try {
    sh(`git add -A`, repoDir);
    sh(`git commit -m ${JSON.stringify(title)} -m ${JSON.stringify(`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`)}`, repoDir);
    sh(`git push -u origin "${branch}"`, repoDir);
  } catch (err) {
    return { ok: false, error: `push failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  let prUrl: string;
  try {
    prUrl = sh(
      `gh pr create --repo "${repo}" --head "${branch}" --title ${JSON.stringify(title)} --body ${JSON.stringify(body)}`,
      repoDir,
    ).trim().split("\n").pop() || "";
  } catch (err) {
    return { ok: false, error: `gh pr create failed: ${err instanceof Error ? err.message : String(err)}`, branch };
  }

  // Auto-merge policy: code NEVER auto-merges; brain docs only when flagged.
  const p = todo.payload as { auto_merge?: boolean };
  const mayAutoMerge = todo.action_type === "brain_doc_edit" && p.auto_merge === true;
  if (mayAutoMerge) {
    try {
      sh(`gh pr merge "${prUrl}" --repo "${repo}" --squash --auto`, repoDir);
    } catch {
      // Non-fatal: leave it open for manual merge.
    }
  }

  return { ok: true, pr_url: prUrl, branch, file: touched };
}

/** Execute one approved system-level todo. */
export async function executeSystemTodo(
  admin: Admin,
  todo: AgentTodo,
  opts: SystemExecOptions,
): Promise<ExecutionResult> {
  switch (todo.action_type) {
    case "sonnet_prompt_new":
    case "sonnet_prompt_edit":
      return execSonnetPrompt(admin, todo);
    case "ticket_analysis_rescore":
      return execAnalysisRescore(admin, todo);
    case "brain_doc_edit":
    case "code_change":
    case "grader_prompt_edit":
    case "escalation_rule_fix":
      return execPrAction(todo, opts);
    default:
      return { ok: false, error: `executeSystemTodo cannot handle ${todo.action_type}` };
  }
}
