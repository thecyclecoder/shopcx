/**
 * agent-todo-routine-run.ts — the per-tick entry point for the hourly
 * Claude Code Routine `agent-todo-routine`.
 *
 * Runs the routine's passes in order:
 *   1. Reasoning pass — propose todos for escalated tickets without an active group.
 *   2. System-level execution pass — execute approved system-level todos
 *      (sonnet_prompt_*, ticket_analysis_rescore via DB; brain/code/grader/
 *      escalation_rule via CI-gated PR). Customer-facing approvals execute
 *      immediately via the Inngest worker, NOT here.
 *   3. PR-cleanup pass — reconcile merge status of executed PR todos.
 *
 * The Routine clones the repo, sets cwd to the repo root, and runs:
 *   npx tsx scripts/agent-todo-routine-run.ts
 *
 * State lives entirely in agent_todos (the Routine is stateless between runs).
 *
 * See docs/brain/inngest/agent-todo-routine.md.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Load .env.local if present (local/dev). In the Routine, env comes from the
// configured environment, so a missing .env.local is fine.
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}

import { createAdminClient } from "../src/lib/supabase/admin";
import { runReasoningPass } from "../src/lib/agent-todos/reasoning";
import { executeSystemTodo } from "../src/lib/agent-todos/system-execute";
import { SYSTEM_LEVEL_ACTION_TYPES } from "../src/lib/agent-todos/constants";
import type { AgentTodo } from "../src/lib/agent-todos/types";

const WORKSPACE_ID = process.env.AGENT_TODO_WORKSPACE_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const REPO_DIR = process.cwd();

async function reasoningPass(runId: string) {
  console.log("[routine] reasoning pass…");
  const results = await runReasoningPass({ workspaceId: WORKSPACE_ID, routineRunId: runId, repoDir: REPO_DIR });
  const groups = results.filter((r) => r.groupId).length;
  const todos = results.reduce((n, r) => n + (r.groupId ? r.proposed.length : 0), 0);
  console.log(`[routine] reasoning: ${results.length} tickets · ${groups} new groups · ${todos} todos`);
}

async function systemExecutionPass() {
  console.log("[routine] system-level execution pass…");
  const admin = createAdminClient();
  const { data: approved } = await admin
    .from("agent_todos")
    .select("*")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("status", "approved")
    .in("action_type", SYSTEM_LEVEL_ACTION_TYPES);

  for (const row of (approved || []) as AgentTodo[]) {
    console.log(`  → ${row.action_type} ${row.id.slice(0, 8)}: ${row.summary}`);
    let result;
    try {
      result = await executeSystemTodo(admin, row, { repoDir: REPO_DIR });
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await admin
      .from("agent_todos")
      .update({
        status: result.ok ? "executed" : "failed",
        execution_result: result,
        executed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    console.log(result.ok ? `    ✓ ${result.pr_url || result.row_id || "done"}` : `    ✗ ${result.error?.slice(0, 200)}`);
  }
}

async function prCleanupPass() {
  console.log("[routine] PR-cleanup pass…");
  const repo = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
  const token = process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
  if (!token) {
    console.log("  (no GitHub token — skipping)");
    return;
  }
  const admin = createAdminClient();
  const { data: executed } = await admin
    .from("agent_todos")
    .select("id, execution_result")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("status", "executed");

  for (const row of executed || []) {
    const url = (row.execution_result as { pr_url?: string; merged_at?: string } | null)?.pr_url;
    if (!url || (row.execution_result as { merged_at?: string })?.merged_at) continue;
    const num = url.split("/").pop();
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${num}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (!res.ok) continue;
      const pr = (await res.json()) as { merged?: boolean; state?: string; merged_at?: string };
      if (pr.merged) {
        await admin
          .from("agent_todos")
          .update({ execution_result: { ...(row.execution_result || {}), merged_at: pr.merged_at }, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        console.log(`  ✓ ${row.id.slice(0, 8)} merged`);
      } else if (pr.state === "closed") {
        await admin
          .from("agent_todos")
          .update({ status: "rejected", reject_reason: "pr_closed_without_merge", updated_at: new Date().toISOString() })
          .eq("id", row.id);
        console.log(`  · ${row.id.slice(0, 8)} closed without merge → rejected`);
      }
    } catch {
      // best-effort
    }
  }
}

/**
 * Preflight: report exactly which expected env vars this run received.
 * The cloud routine once reported a clean "0 tickets / 0 todos" because
 * createAdminClient() got an undefined Supabase URL/key — every query then
 * returns empty with no thrown error, so a misconfigured run looks like a
 * healthy no-op. Fail loudly instead: log present-vs-missing for each var,
 * and abort when the ones we can't run without are absent.
 */
async function checkEnv() {
  const has = (k: string) => !!(process.env[k] && process.env[k] !== "");
  // Without these every Supabase query silently returns empty → abort.
  const REQUIRED = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  // Missing these degrades a pass but doesn't make the run a silent lie.
  const RECOMMENDED = [
    "ENCRYPTION_KEY", // decrypt per-workspace integration creds during execution
    "ANTHROPIC_API_KEY", // reasoning pass (skippable if authed via Claude OAuth/Max)
    "OPENAI_API_KEY", // embeddings for brain/context lookups
    "GITHUB_TOKEN", // PR-cleanup pass (or AGENT_TODO_GITHUB_TOKEN)
    "RESEND_API_KEY",
  ];

  console.log("[routine] env preflight:");
  for (const k of REQUIRED) console.log(`  ${has(k) ? "✓" : "✗ MISSING"}  ${k}  (required)`);
  for (const k of RECOMMENDED) {
    const present = k === "GITHUB_TOKEN" ? has("GITHUB_TOKEN") || has("AGENT_TODO_GITHUB_TOKEN") : has(k);
    console.log(`  ${present ? "✓" : "·  "}  ${k}${present ? "" : "  (missing — that pass will be degraded/skipped)"}`);
  }

  const missing = REQUIRED.filter((k) => !has(k));
  if (missing.length) {
    console.error(`\n[routine] ABORT — missing required env var(s): ${missing.join(", ")}.`);
    console.error("[routine] Without Supabase creds every query returns empty and the run would silently do nothing.");
    console.error("[routine] Populate the routine environment (npx tsx scripts/print-routine-env.ts) and re-trigger.");
    process.exit(1);
  }

  // Env vars present is necessary but NOT sufficient. The cloud environment's
  // network policy can still block outbound to the Supabase host ("Host not
  // in allowlist"); supabase-js surfaces that as { data: null, error }, which
  // every caller treats as an empty result — so a network-blocked run looks
  // identical to a healthy no-op. Probe the DB for real and abort on any
  // error, so a blocked host (or revoked key) fails loudly with the reason.
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("workspaces")
      .select("id", { count: "exact", head: true })
      .eq("id", WORKSPACE_ID);
    if (error) throw new Error(error.message);
    console.log("  ✓  Supabase live query OK (host reachable, key valid)");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\n[routine] ABORT — Supabase env present but the live query failed: ${msg}`);
    console.error("[routine] Most likely the environment's network policy blocks outbound to your Supabase host");
    console.error("[routine] (the 'Host not in allowlist' case), so requests never reach the DB.");
    console.error("[routine] Allow *.supabase.co — and the other API hosts the routine calls (api.anthropic.com,");
    console.error("[routine] api.openai.com, api.github.com, api.resend.com, *.appstle.com, etc.) — in the routine");
    console.error("[routine] environment's network settings, then re-trigger.");
    process.exit(1);
  }
}

async function main() {
  const runId = randomUUID();
  console.log(`[routine] agent-todo-routine run ${runId} · workspace ${WORKSPACE_ID} · repo ${REPO_DIR}`);
  await checkEnv();
  await reasoningPass(runId);
  await systemExecutionPass();
  await prCleanupPass();
  console.log("[routine] done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
