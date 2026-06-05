/**
 * Agent To-Do system — execution of SYSTEM-level todos.
 *
 * Runs ONLY inside the Claude Code Routine (it shells out to git and calls the
 * GitHub REST API, and needs the repo checked out). Never imported by Vercel
 * serverless code. NOTE: `gh` CLI is not available in the Routine env — PRs are
 * opened via the REST API (ghApi), not `gh`.
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
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
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

function ghToken(): string {
  const t = process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
  if (!t) throw new Error("missing GITHUB_TOKEN / AGENT_TODO_GITHUB_TOKEN — cannot call the GitHub API");
  return t;
}

// The `gh` CLI is NOT installed in the Routine's cloud environment (only git
// is), so PR creation/merge goes through the GitHub REST API with GITHUB_TOKEN
// instead of shelling out to `gh`. Same auth the push already uses; same
// pattern as the PR-cleanup pass and the /api/branches route.
async function ghApi(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
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

  // Hallucination guard — if the model proposed a file_path that doesn't
  // exist in the repo, fail fast with a clear error. Without this, git apply
  // produces a generic "No valid patches in input" that masks the real
  // problem (Opus guessing at the file structure rather than referencing
  // a file the reasoning pass actually grounded against).
  if (p.file_path) {
    const abs = join(repoDir, p.file_path);
    // For new_file_body we expect the file NOT to exist (we're creating it),
    // so only enforce existence when applying a unified_diff to a known file.
    if (p.unified_diff && !existsSync(abs)) {
      throw new Error(
        `proposed file_path "${p.file_path}" does not exist in the repo — likely hallucinated; reject this todo and re-prompt the reasoning pass with explicit file context`,
      );
    }
  }

  if (p.unified_diff) {
    const patchFile = join(repoDir, `.agent-todo-${todo.id}.patch`);
    writeFileSync(patchFile, p.unified_diff.endsWith("\n") ? p.unified_diff : p.unified_diff + "\n");
    try {
      // Strict first. LLM-generated diffs routinely miscount hunk headers
      // (e.g. "@@ -34,7 @@" when the body holds 6 old-side lines), which
      // git rejects as "corrupt patch". --recount recomputes the line
      // counts from the actual hunk body, recovering those otherwise-good
      // patches. Retry with it before giving up; context still has to match.
      try {
        sh(`git apply --whitespace=nowarn "${patchFile}"`, repoDir);
      } catch {
        sh(`git apply --whitespace=nowarn --recount "${patchFile}"`, repoDir);
      }
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
  let prNumber: number | undefined;
  try {
    const base = process.env.AGENT_TODO_BASE_BRANCH || "main";
    const pr = (await ghApi("POST", `/repos/${repo}/pulls`, { title, head: branch, base, body })) as {
      html_url?: string;
      number?: number;
    };
    prUrl = pr.html_url || "";
    prNumber = pr.number;
  } catch (err) {
    // Branch is already pushed; only PR creation failed. Surface the branch so
    // it can be recovered (open a PR for it) without re-running the diff.
    return { ok: false, error: `open PR failed: ${err instanceof Error ? err.message : String(err)}`, branch };
  }

  // Auto-merge policy: code NEVER auto-merges; brain docs only when flagged.
  const p = todo.payload as { auto_merge?: boolean };
  const mayAutoMerge = todo.action_type === "brain_doc_edit" && p.auto_merge === true;
  if (mayAutoMerge && prNumber) {
    try {
      await ghApi("PUT", `/repos/${repo}/pulls/${prNumber}/merge`, { merge_method: "squash" });
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
