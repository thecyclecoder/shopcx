/**
 * builder-worker — the box-side build worker for the Roadmap Build Console.
 *
 * Runs on the self-hosted box (Hetzner CCX33, tailnet-locked, non-root `builder`). Polls the
 * agent_jobs queue OUTBOUND, claims jobs via claim_agent_job(), and runs each build in its OWN
 * git worktree (isolated dir + branch) as a headless `claude -p` on Max (ANTHROPIC_API_KEY +
 * prod secrets stripped). Up to MAX_CONCURRENT builds run in PARALLEL. Gates on tsc, opens a
 * claude/* PR. Pauses on needs_input (questions) / needs_approval (gated prod actions) and
 * resumes the same session once answered/approved.
 * See docs/brain/specs/roadmap-build-console.md + parallel-builds.md.
 *
 * Run: cd /home/builder/shopcx && npx tsx scripts/builder-worker.ts   (via systemd shopcx-builder)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { spawn, spawnSync } from "child_process";
import { randomUUID } from "crypto";
// Type-only (erased at compile — never loads the module at startup): the solver/skeptic JSON contracts.
import type { SolverProposal, SkepticVerdict } from "../src/lib/agent-todos/triage";

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

const REPO_DIR = resolve(__dirname, "..");
const BUILDS_DIR = resolve(REPO_DIR, "../builds"); // each build gets its own worktree here
const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN || "";
const POLL_MS = 5000;
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
// Product-seed runs the full Engine to completion on Max (per-ingredient web
// research + ~2000-review analysis + content + imagery) — give it a long ceiling.
const SEED_TIMEOUT_MS = 90 * 60 * 1000;
// A ticket-improve turn is one Max `claude -p` investigation/proposal (read brain/src + web + the
// read-only DB tools). Minutes, not the 90-min seed ceiling. See box-ticket-improve.
const IMPROVE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CONCURRENT = 5; // build/plan pool — real ceiling is Max rate limits, not the box
// Fold-builds run in their OWN concurrency-1 lane (fold-build-batching Phase 2): a fold edits the shared
// index files (archive.md / README counts → now generated), so it must never race a feature build.
const MAX_FOLD = 1;
// Product-seed jobs (box-product-seeding) run as a top-level Max `claude -p`
// (seed-product skill) in their own lane so a long seed (per-ingredient web
// research + ~2000-review analysis + imagery) never occupies a feature-build
// lane. Each is one long-running claude session, so a small cap is right.
const MAX_SEED = 2;
// Spec-chat turns (box-spec-chat) run a long-running, resumable top-level Max `claude -p` (the authoring
// chat moved off the Anthropic API onto the box). Its OWN concurrency-1 lane: interactive + serialized
// per box, so a chat turn never occupies a feature-build lane (and vice-versa). One turn at a time is
// right — the founder converses turn-by-turn, the UI disables the composer while a turn is in flight.
const MAX_SPEC_CHAT = 1;
// Ticket-improve turns (box-ticket-improve) run in their OWN concurrency-1 interactive lane: a
// resumable Max `claude -p` session per ticket, one short job per turn. Serialized so a turn never
// races the self-update reset of REPO_DIR (it reads brain/src in the main checkout, read-only).
const MAX_TICKET_IMPROVE = 1;
// Escalation-triage sweeps (box-escalation-triage) run in their OWN concurrency-1 lane: one hourly
// agent_jobs row per workspace, processed as a batch of solver→skeptic→quorum loops (each loop is 2–4
// separate top-level Max `claude -p` sessions). Serialized so a long sweep never races other lanes.
const MAX_TRIAGE = 1;
// A solver/skeptic pass is one Max `claude -p` investigation (read brain/src + web + read-only DB
// tools). Minutes, not the 90-min seed ceiling — same ballpark as a ticket-improve turn.
const TRIAGE_PASS_TIMEOUT_MS = 15 * 60 * 1000;
// Spec-test runs (spec-test-agent) run in their OWN concurrency-1 lane: a top-level Max `claude -p`
// QA pass over ONE shipped-but-unverified spec's `## Verification` checklist — non-destructive checks
// only (repo/tsc, gh CI, vercel deploy+logs+env, read-only DB probes, GET endpoints). It NEVER mutates
// prod and NEVER marks a spec verified/archived; it stamps a spec_test_runs row. Serialized (one box).
const MAX_SPEC_TEST = 1;
// One spec-test pass reads the spec + runs the box QA toolkit (tsc can be slow). Minutes, not the
// 90-min seed ceiling — give it a build-sized ceiling so a tsc + a few probes never get cut short.
const SPEC_TEST_TIMEOUT_MS = 20 * 60 * 1000;
// Migration-fix jobs (migration-fix-agent) run in their OWN concurrency-1 lane: a top-level Max
// `claude -p` (migration-fix skill) that DIAGNOSES a failed migration_audits row read-only and PROPOSES
// the judgment fixes auto-heal punts; prod billing mutations are GATED (executed by the worker via
// src/lib/migration-fix.ts on approval), then it re-runs verifyMigration. Serialized — a billing repair
// must never race another, and one box session per audit is right (event-driven, not a sweep).
const MAX_MIGRATION_FIX = 1;
// One migration-fix pass: diagnose the failing checks read-only (re-fetch live Appstle, the sub, the
// catalog) + propose a typed fix. Minutes — same ballpark as a ticket-improve turn, not the seed ceiling.
const MIGRATION_FIX_TIMEOUT_MS = 15 * 60 * 1000;
// Developer Message Center turns (developer-message-center) run in their OWN concurrency-1 interactive
// lane: a resumable Max `claude -p` session per thread that carries read-only DB access AND WebSearch
// (the founder's "ask the box anything" analyst/planner). Serialized so a turn never races the per-thread
// worktree's self-update (git reset --hard origin/main) of an in-flight read; its own pool, so it must
// not starve the 5 build/plan lanes. A turn can be a long DB-analytics + investigation pass — give it a
// build-sized ceiling so a heavy join + a few read probes never get cut short.
const MAX_DEV_ASK = 1;
const DEV_ASK_TIMEOUT_MS = 20 * 60 * 1000;
// How many escalated tickets one hourly sweep processes (bound the cost; the rest are logged + deferred).
const TRIAGE_CAP = Number(process.env.AGENT_TODO_TRIAGE_CAP || 5);
// Worker safety net (build-lifecycle-hardening Phase 2): cap how often a resume may auto-settle the
// SAME already-applied action before we stop the loop and surface it for a human. Normally 0–1.
const AUTO_SETTLE_MAX = 2;

// ── Self-update (worker-self-update) ────────────────────────────────────────
// The worker keeps its OWN code current: when fully idle it fetches origin/main and, if behind,
// resets the main repo to it and exits — systemd Restart=always relaunches the fresh builder-worker.ts.
const WORKER_BOX_ID = process.env.WORKER_BOX_ID || "box"; // singleton heartbeat key (supports >1 box later)
const SELF_UPDATE_MIN_INTERVAL_MS = 60 * 1000; // don't thrash: at most one self-update check per minute
// Crash-loop guard: if the freshly-pulled worker keeps dying on startup we stop flapping and leave a
// needs_attention heartbeat for a human instead of churning forever. Counter persists across restarts.
const CRASH_FILE = resolve(REPO_DIR, "../.worker-startup.json");
const CRASH_LOOP_MAX = 3; // consecutive startup crashes on the SAME sha before we give up + alert
const RUNNING_SHA = (() => {
  try {
    return spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_DIR, encoding: "utf8" }).stdout?.trim() || "";
  } catch {
    return "";
  }
})();
let lastSelfUpdateCheck = 0;

type JobStatus = "queued" | "claimed" | "building" | "needs_input" | "needs_approval" | "queued_resume" | "completed" | "failed" | "needs_attention";
// A planner-proposed spec branch, carried on a type:'spec' action (goal-decomposition-engine).
interface ProposedSpec {
  slug: string;
  title: string;
  owner: string;
  parent: string;
  milestone?: string;
  intent: string;
  gap?: string;
}
interface PendingAction {
  id: string;
  type: "apply_migration" | "run_prod_script" | "merge_pr" | "spec" | "migration_fix";
  summary: string;
  cmd?: string;
  preview?: string;
  status: "pending" | "approved" | "declined" | "done" | "failed";
  result?: string;
  spec?: ProposedSpec;
  autoSettled?: number; // worker safety net: times a resumed build re-requested this already-`done` cmd
  // set when type==='migration_fix' (migration-fix-agent): the typed billing repair the worker runs via
  // src/lib/migration-fix.ts `applyMigrationFix` on approval.
  fix_kind?: "price_reconcile" | "variant_backfill" | "appstle_cancel";
  payload?: unknown;
}
interface Job {
  id: string;
  workspace_id: string;
  spec_slug: string; // for kind='plan' this is the GOAL slug; for kind='fold' a 'fold-batch' sentinel
  spec_branch: string | null;
  kind: "build" | "plan" | "fold" | "product-seed" | "ticket-improve" | "spec-chat" | "triage-escalations" | "spec-test" | "migration-fix" | "dev-ask";
  status: JobStatus;
  claude_session_id: string | null;
  instructions: string | null;
  created_by: string | null;
  answers: { id: string; answer: string }[];
  pending_actions: PendingAction[];
  pr_number: number | null;
}

async function admin() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  return createAdminClient();
}

function sh(cmd: string, args: string[], opts: { timeout?: number; cwd?: string } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || REPO_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout });
  return { code: r.status ?? -1, out: r.stdout || "", err: r.stderr || "" };
}

// Async (NON-blocking) exec — REQUIRED for the long-running claude/tsc/apply steps so concurrent
// build lanes actually overlap. spawnSync freezes the whole event loop and would serialize lanes.
function shAsync(cmd: string, args: string[], opts: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd || REPO_DIR, env: opts.env || process.env });
    let out = "";
    let err = "";
    const cap = 64 * 1024 * 1024;
    child.stdout?.on("data", (d) => { out += d.toString(); if (out.length > cap) out = out.slice(-cap); });
    child.stderr?.on("data", (d) => { err += d.toString(); if (err.length > cap) err = err.slice(-cap); });
    const timer = opts.timeout ? setTimeout(() => child.kill("SIGKILL"), opts.timeout) : null;
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, out, err }); });
    child.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, out, err: err + String(e) }); });
  });
}

// A fresh box has no git identity → `git commit` errors. Repo-local config is shared across worktrees.
function ensureGitIdentity() {
  sh("git", ["config", "user.email", "builder@shopcx.ai"]);
  sh("git", ["config", "user.name", "ShopCX Build Worker"]);
}

// Secrets stripped from the BUILD's env so a bypass build can't reach prod. The worker keeps
// these in its own env (from the systemd EnvironmentFile) to execute APPROVED actions.
const SECRET_RE = /SERVICE_ROLE|PASSWORD|SECRET|_TOKEN|PRIVATE|BRAINTREE|TWILIO|RESEND|AVALARA|EASYPOST|KLAVIYO|META_|ANTHROPIC|OPENAI|SUPABASE_DB/i;

async function runClaude(prompt: string, sessionId: string | null, cwd: string) {
  // Sandbox: stay on Max (no API key) AND drop prod-write secrets. Keep NEXT_PUBLIC_* (non-secret).
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "ANTHROPIC_API_KEY") continue;
    if (/^NEXT_PUBLIC_/.test(k)) { env[k] = v; continue; }
    if (SECRET_RE.test(k)) continue;
    env[k] = v;
  }
  const base = sessionId ? ["--resume", sessionId] : [];
  const args = [...base, "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json"];
  const r = await shAsync("claude", args, { cwd, env, timeout: BUILD_TIMEOUT_MS });
  let session = sessionId;
  let resultText = "";
  let isError = r.code !== 0;
  try {
    const obj = JSON.parse((r.out || "").trim());
    session = obj.session_id || session;
    resultText = typeof obj.result === "string" ? obj.result : JSON.stringify(obj);
    isError = isError || obj.is_error === true;
  } catch {
    resultText = (r.out || "") + (r.err || "");
  }
  return { session, resultText, isError, raw: (r.out || "") + (r.err || "") };
}

// Box product-seed runner (box-product-seeding): launch a TOP-LEVEL `claude -p`
// on Max for a seed job. Web search stays available (research). ANTHROPIC_API_KEY
// is UNSET (`env -u ANTHROPIC_API_KEY`) so ALL LLM is Max-billed, zero per-token
// spend — but UNLIKE a feature-build sandbox we KEEP the DB/crypto/Gemini/Drive
// secrets, because the seed-product skill's deterministic tools must write the
// workspace DB + storage and decrypt the per-workspace Gemini/Drive keys. This is
// a trusted, fixed skill driving fixed tools (it never edits repo code), so it
// runs at the same trust level as the old in-process seed.
async function runSeedClaude(prompt: string, sessionId: string | null, cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // stay on Max — never the Anthropic API
  const base = sessionId ? ["--resume", sessionId] : [];
  const args = [...base, "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json"];
  const r = await shAsync("claude", args, { cwd, env, timeout: SEED_TIMEOUT_MS });
  let session = sessionId;
  let resultText = "";
  let isError = r.code !== 0;
  try {
    const obj = JSON.parse((r.out || "").trim());
    session = obj.session_id || session;
    resultText = typeof obj.result === "string" ? obj.result : JSON.stringify(obj);
    isError = isError || obj.is_error === true;
  } catch {
    resultText = (r.out || "") + (r.err || "");
  }
  return { session, resultText, isError, raw: (r.out || "") + (r.err || "") };
}

function parseStatus(text: string): { status: string; questions?: unknown[]; summary?: string; no_changes_reason?: string } | null {
  const tryParse = (s: string) => {
    try {
      const o = JSON.parse(s);
      return o && typeof o === "object" && "status" in o ? o : null;
    } catch {
      return null;
    }
  };
  let o = tryParse(text.trim());
  if (o) return o;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    o = tryParse(fence[1].trim());
    if (o) return o;
  }
  const idx = text.indexOf('{"status"');
  if (idx >= 0) {
    const last = text.lastIndexOf("}");
    if (last > idx) o = tryParse(text.slice(idx, last + 1));
    if (o) return o;
  }
  return null;
}

// Generic last-JSON-object extractor for the solver/skeptic passes (they emit a final JSON object that
// is NOT a {"status":…} envelope). Tries raw → fenced ```json``` → the widest {…} span.
function extractJson<T = Record<string, unknown>>(text: string): T | null {
  const tryParse = (s: string): T | null => {
    try {
      const o = JSON.parse(s);
      return o && typeof o === "object" ? (o as T) : null;
    } catch {
      return null;
    }
  };
  let o = tryParse(text.trim());
  if (o) return o;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    o = tryParse(fence[1].trim());
    if (o) return o;
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) o = tryParse(text.slice(first, last + 1));
  return o;
}

async function gh(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : {} };
}

async function ensurePr(branch: string, title: string, draft: boolean, body?: string): Promise<{ url: string; number: number } | null> {
  const owner = REPO.split("/")[0];
  const created = await gh("POST", `/repos/${REPO}/pulls`, {
    title,
    head: branch,
    base: "main",
    body: body ?? `Automated build of \`docs/brain/specs/${title}\` by the box worker. ${draft ? "**Draft — has open questions.**" : ""}`,
    draft,
  });
  if (created.ok) return { url: created.json.html_url as string, number: created.json.number as number };
  const existing = await gh("GET", `/repos/${REPO}/pulls?head=${owner}:${branch}&state=open`);
  if (existing.ok && Array.isArray(existing.json) && existing.json.length) {
    return { url: existing.json[0].html_url as string, number: existing.json[0].number as number };
  }
  return null;
}

// A build that paused (needs_input/needs_approval) opened its PR as a DRAFT. On completion the PR is
// reused, so mark it ready-for-review or it stays unmergeable. REST can't un-draft a PR; GraphQL can.
// One attempt: fetch the PR's node_id FRESH (must be after the final push), run the mutation, and
// confirm the result is non-draft. Returns ok=false (with a reason) rather than swallowing — PR#75/#76
// stayed draft because the old catch hid a GraphQL error/timing race.
async function markReadyOnce(prNumber: number): Promise<{ ok: boolean; isDraft: boolean | null; detail: string }> {
  const pr = await gh("GET", `/repos/${REPO}/pulls/${prNumber}`);
  const node = pr.json as { node_id?: string; draft?: boolean };
  if (!node?.node_id) return { ok: false, isDraft: null, detail: `GET pull failed (${pr.status})` };
  if (node.draft === false) return { ok: true, isDraft: false, detail: "already ready-for-review" };
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${GH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `mutation { markPullRequestReadyForReview(input: { pullRequestId: "${node.node_id}" }) { pullRequest { isDraft } } }` }),
  });
  const text = await res.text();
  let body: { data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } } }; errors?: unknown } = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* keep raw text in detail */ }
  if (!res.ok) return { ok: false, isDraft: null, detail: `graphql HTTP ${res.status}: ${text.slice(0, 200)}` };
  if (body.errors) return { ok: false, isDraft: null, detail: `graphql errors: ${JSON.stringify(body.errors).slice(0, 300)}` };
  const after = body.data?.markPullRequestReadyForReview?.pullRequest?.isDraft;
  return { ok: after === false, isDraft: typeof after === "boolean" ? after : null, detail: after === false ? "marked ready" : "mutation returned still-draft" };
}

// Un-draft a PR, logging (never swallowing) failures and retrying once. Returns true once the PR is
// confirmed non-draft. The build completion path adds a belt-and-suspenders re-check before flipping
// the job to `completed` (see runJob).
async function markReady(prNumber: number): Promise<boolean> {
  try {
    let r = await markReadyOnce(prNumber);
    if (!r.ok) {
      console.error(`[markReady] PR#${prNumber} attempt 1 failed: ${r.detail} — retrying once`);
      r = await markReadyOnce(prNumber);
      if (!r.ok) console.error(`[markReady] PR#${prNumber} attempt 2 failed: ${r.detail} — may need a manual "Ready for review"`);
    }
    return r.ok;
  } catch (e) {
    console.error(`[markReady] PR#${prNumber} threw: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

let db: Awaited<ReturnType<typeof admin>>;

async function update(id: string, patch: Record<string, unknown>) {
  await db.from("agent_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

// ── Heartbeat + self-update (worker-self-update) ─────────────────────────────
// Upsert the singleton worker_heartbeats row so the dashboard can show "worker: <sha>, healthy Ns ago"
// (and surface a crash-loop) without SSH. Best-effort: a heartbeat write must never break the poll loop.
const WORKER_STARTED_AT = new Date().toISOString();
// One in-flight lane, surfaced on the heartbeat so the dashboard can show what each lane is building
// right now (build-box-status-view). job_id ties back to agent_jobs; since = when the lane started.
interface LaneRow { kind: Job["kind"]; job_id: string; spec_slug: string; since: string }
async function writeHeartbeat(activeBuilds: number, status: string, detail?: string, lanes: LaneRow[] = []) {
  try {
    await db.from("worker_heartbeats").upsert({
      id: WORKER_BOX_ID,
      running_sha: RUNNING_SHA,
      status,
      active_builds: activeBuilds,
      detail: detail ?? null,
      build_lanes: MAX_CONCURRENT, // total build/plan lanes (the pool ceiling)
      fold_lanes: MAX_FOLD, // total fold lanes (concurrency-1 lane)
      lanes, // [{ kind, job_id, spec_slug, since }] for every in-flight lane this tick
      started_at: WORKER_STARTED_AT,
      last_poll_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[heartbeat] write failed:", e instanceof Error ? e.message : String(e));
  }
}

// Control Tower (control-tower spec, Phase 1): one loop_heartbeats row at the END of every
// agent-kind run (loop_id = `agent:<kind>`). The control-tower-monitor cron reads the latest
// beat for last-ran/history; the STUCK-JOB alert is driven off agent_jobs, not this beat — so a
// genuinely-idle lane stays green. Best-effort: a heartbeat write must never break the poll loop.
async function writeLoopHeartbeat(loopId: string, ok: boolean, produced: unknown, durationMs: number) {
  try {
    await db.from("loop_heartbeats").insert({
      loop_id: loopId,
      kind: "agent-kind",
      ok,
      produced: produced ?? null,
      duration_ms: durationMs,
      ran_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[loop-heartbeat] write failed:", e instanceof Error ? e.message : String(e));
  }
}

// Idle self-update: ONLY when no build/fold lane is running (active === 0 — in-flight work is sacrosanct).
// Fetch origin, and if local HEAD is behind origin/main, hard-reset the MAIN repo (worktrees live in a
// sibling dir, so this never touches a running build), npm ci if deps changed, then exit(0) — systemd
// Restart=always relaunches the worker on the fresh builder-worker.ts. A clean exit + restart is the
// safe re-exec; never hot-reload in-process. Returns true when it has triggered an exit path.
async function maybeSelfUpdate(activeBuilds: number): Promise<void> {
  if (activeBuilds !== 0) return; // never self-update mid-build/fold
  const now = Date.now();
  if (now - lastSelfUpdateCheck < SELF_UPDATE_MIN_INTERVAL_MS) return; // don't thrash
  lastSelfUpdateCheck = now;

  const fetched = sh("git", ["fetch", "origin", "main"]);
  if (fetched.code !== 0) {
    console.error(`[self-update] git fetch failed: ${fetched.err.slice(0, 200)}`);
    return;
  }
  const local = sh("git", ["rev-parse", "HEAD"]).out.trim();
  const remote = sh("git", ["rev-parse", "origin/main"]).out.trim();
  if (!local || !remote || local === remote) return; // current → no-op (no thrash)

  const fromTo = `${local.slice(0, 8)}→${remote.slice(0, 8)}`;
  console.log(`[self-update] behind origin/main (${fromTo}) — updating worker code`);
  // Detect a dependency change BEFORE the reset (diff the range we're about to apply).
  const depsChanged = sh("git", ["diff", "--name-only", local, remote]).out.includes("package-lock.json");

  const reset = sh("git", ["reset", "--hard", "origin/main"]);
  if (reset.code !== 0) {
    console.error(`[self-update] git reset failed: ${reset.err.slice(0, 200)}`);
    return;
  }
  if (depsChanged) {
    console.log("[self-update] package-lock.json changed → npm ci");
    const ci = sh("npm", ["ci"], { timeout: 10 * 60 * 1000 });
    if (ci.code !== 0) console.error(`[self-update] npm ci failed (continuing): ${ci.err.slice(-300)}`);
  }
  await writeHeartbeat(0, "updating", `self-update ${fromTo}`);
  console.log(`[self-update] reset to ${remote.slice(0, 8)} → exiting for systemd restart`);
  process.exit(0);
}

// Crash-loop guard (worker-self-update Phase 2): persist a per-sha startup-attempt counter. If the
// freshly-pulled worker keeps dying on startup (same sha, ≥ CRASH_LOOP_MAX times) we leave a
// needs_attention breadcrumb and exit non-zero so systemd's StartLimit can stop the flapping, instead
// of silently churning. clearStartupCrashCounter() runs once the worker reaches a healthy steady state.
function readCrashFile(): { sha: string; count: number; alerted: boolean } {
  try {
    if (existsSync(CRASH_FILE)) {
      const o = JSON.parse(readFileSync(CRASH_FILE, "utf8"));
      return { sha: String(o.sha || ""), count: Number(o.count) || 0, alerted: !!o.alerted };
    }
  } catch { /* treat a corrupt file as a fresh start */ }
  return { sha: "", count: 0, alerted: false };
}
function writeCrashFile(o: { sha: string; count: number; alerted: boolean }) {
  try { writeFileSync(CRASH_FILE, JSON.stringify(o)); } catch { /* best-effort */ }
}
// Returns true if we're in a crash loop on the current sha and should give up (caller alerts + exits).
function recordStartupAttempt(): boolean {
  const prev = readCrashFile();
  if (prev.sha === RUNNING_SHA) {
    const next = { sha: RUNNING_SHA, count: prev.count + 1, alerted: prev.alerted };
    writeCrashFile(next);
    return next.count >= CRASH_LOOP_MAX;
  }
  // New sha (a self-update or manual deploy moved us) → reset the counter to this attempt.
  writeCrashFile({ sha: RUNNING_SHA, count: 1, alerted: false });
  return false;
}
function clearStartupCrashCounter() {
  // Reached steady state — this sha is healthy. Zero the counter so a LATER crash starts fresh.
  writeCrashFile({ sha: RUNNING_SHA, count: 0, alerted: false });
}

// Execute owner-approved gated actions in the build's worktree. The worker is the ONLY component
// with prod creds; it runs exactly the command the owner approved (shown to them as the preview).
async function executeApprovedActions(job: Job, cwd: string): Promise<{ actions: PendingAction[]; summary: string }> {
  const actions = (job.pending_actions || []).map((a) => ({ ...a }));
  const done: string[] = [];
  for (const a of actions) {
    if (a.status !== "approved") continue;
    try {
      if (a.type === "merge_pr") {
        const r = await gh("PUT", `/repos/${REPO}/pulls/${job.pr_number}/merge`, { merge_method: "squash" });
        a.status = r.ok ? "done" : "failed";
        a.result = r.ok ? "merged" : `merge failed ${r.status}`;
      } else if (a.cmd) {
        const r = await shAsync("bash", ["-lc", a.cmd], { timeout: 10 * 60 * 1000, cwd });
        a.status = r.code === 0 ? "done" : "failed";
        a.result = (r.out + r.err).slice(-500);
      } else {
        a.status = "failed";
        a.result = "no command to run";
      }
    } catch (e) {
      a.status = "failed";
      a.result = e instanceof Error ? e.message : String(e);
    }
    done.push(`${a.summary} → ${a.status}`);
  }
  return { actions, summary: done.join("; ") };
}

// Commit a single file straight to main via the GitHub Contents API — the chat/finalize authoring
// pattern (a spec is docs, already gated by the approve-tree step). Race-free for the build jobs we
// queue next: the build pipeline bases every new build on origin/main, so the spec must be there.
async function putFileMain(filePath: string, content: string, message: string) {
  const get = await gh("GET", `/repos/${REPO}/contents/${filePath}?ref=main`);
  const sha = get.ok ? (get.json as { sha?: string }).sha : undefined;
  return gh("PUT", `/repos/${REPO}/contents/${filePath}`, {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    sha,
    branch: "main",
  });
}

// Re-plan hygiene: record declined proposals as ❌ in the goal doc so re-plan never re-proposes them.
// Best-effort append under a "## Declined branches" section (created if absent).
async function recordDeclined(goalSlug: string, declined: ProposedSpec[]) {
  if (!declined.length) return;
  const filePath = `docs/brain/goals/${goalSlug}.md`;
  const get = await gh("GET", `/repos/${REPO}/contents/${filePath}?ref=main`);
  if (!get.ok) return;
  const sha = (get.json as { sha?: string }).sha;
  let md = Buffer.from(String((get.json as { content?: string }).content || "").replace(/\s/g, ""), "base64").toString("utf8");
  const lines = declined.map((d) => `- ❌ ${d.slug} — ${d.title} (declined; not re-proposed)`).join("\n");
  if (/##\s+Declined branches/i.test(md)) {
    md = md.replace(/(##\s+Declined branches[^\n]*\n)/i, `$1${lines}\n`);
  } else {
    md = `${md.trimEnd()}\n\n## Declined branches\n\n${lines}\n`;
  }
  await gh("PUT", `/repos/${REPO}/contents/${filePath}`, {
    message: `plan: ${goalSlug} → record ${declined.length} declined branch(es)`,
    content: Buffer.from(md, "utf8").toString("base64"),
    sha,
    branch: "main",
  });
}

// A kind='plan' job. First run: the plan-goal skill proposes a milestone→spec tree → needs_approval
// (no files written, no PR). Resume (after the owner approves branches): author the approved specs +
// wikilink them into the goal doc (committed to main), record declines (❌), and queue their builds.
async function runPlanJob(job: Job) {
  const goalSlug = job.spec_slug;
  const isResume = !!job.claude_session_id;
  const tag = `[plan:${goalSlug}]`;
  const wt = join(BUILDS_DIR, job.id);
  console.log(`${tag} ${isResume ? "resuming (authoring approved specs)" : "planning"} (job ${job.id})`);

  sh("git", ["fetch", "origin"]);
  let branch = job.spec_branch;
  sh("git", ["worktree", "remove", "--force", wt]);
  if (!branch) {
    branch = `claude/plan-${goalSlug}-${Date.now().toString(36)}`;
    await update(job.id, { spec_branch: branch });
  }
  const add = sh("git", ["worktree", "add", "-B", branch, wt, "origin/main"]); // scratch worktree (read brain / write spec files locally)
  if (add.code !== 0) throw new Error(`worktree add failed: ${add.err.slice(0, 300)}`);
  sh("ln", ["-sfn", join(REPO_DIR, "node_modules"), join(wt, "node_modules")]);

  try {
    if (!isResume) {
      // PROPOSE — run the plan-goal skill. The planner writes nothing; it emits a tree for approval.
      const prompt = [
        `Use the plan-goal skill to plan the goal docs/brain/goals/${goalSlug}.md (cwd is the repo root).`,
        ...(job.instructions ? [`Extra planning guidance: ${job.instructions}`] : []),
        `You are PROPOSING only — do NOT author specs, do NOT queue builds, do NOT run git. Read the goal + the brain, gap-analyze, and emit the proposed tree. Every proposed spec MUST carry an owner + parent (reject your own orphans).`,
        `Final message = ONLY one JSON object: {"status":"needs_approval","actions":[{"type":"spec","summary":"<title>","preview":"<intent>\\n\\nGap: <brain citation>","spec":{"slug":"…","title":"…","owner":"…","parent":"…","milestone":"…","intent":"…","gap":"…"}}]} | {"status":"completed","summary":"…"} | {"status":"needs_input","questions":[{"id":"q1","q":"…"}]}.`,
      ].join("\n");
      const { session, resultText, isError } = await runClaude(prompt, null, wt);
      if (session) await update(job.id, { claude_session_id: session });
      const parsed = parseStatus(resultText);
      console.log(`${tag} planner finished — status: ${parsed?.status ?? "(none)"} isError=${isError}`);

      if (parsed?.status === "needs_input") {
        await update(job.id, { status: "needs_input", questions: parsed.questions ?? [] });
        return;
      }
      if (parsed?.status === "needs_approval") {
        const incoming: Array<Record<string, unknown>> = Array.isArray((parsed as Record<string, unknown>).actions)
          ? ((parsed as Record<string, unknown>).actions as Array<Record<string, unknown>>)
          : [];
        const pending: PendingAction[] = [];
        incoming.forEach((a, i) => {
          const sp = (a.spec as Record<string, unknown>) || {};
          // No-orphan rule: drop any proposal missing slug/owner/parent — the planner rejects its own orphans.
          if (typeof sp.slug !== "string" || typeof sp.owner !== "string" || typeof sp.parent !== "string") return;
          pending.push({
            id: `s${Date.now().toString(36)}${i}`,
            type: "spec",
            summary: String(a.summary || sp.title || sp.slug),
            preview: typeof a.preview === "string" ? a.preview : String(sp.intent || ""),
            status: "pending",
            spec: {
              slug: sp.slug,
              title: String(sp.title || a.summary || sp.slug),
              owner: sp.owner,
              parent: sp.parent,
              milestone: typeof sp.milestone === "string" ? sp.milestone : undefined,
              intent: String(sp.intent || a.preview || ""),
              gap: typeof sp.gap === "string" ? sp.gap : undefined,
            },
          });
        });
        if (!pending.length) {
          await update(job.id, { status: "completed", log_tail: "planner proposed no valid (owner+parent) specs" });
          return;
        }
        await update(job.id, { status: "needs_approval", pending_actions: pending });
        return;
      }
      await update(job.id, { status: "completed", log_tail: parsed?.summary ? String(parsed.summary) : "no proposals" });
      return;
    }

    // RESUME — author APPROVED specs, wikilink into the goal doc, record declines, queue builds.
    const actions = job.pending_actions || [];
    const approved = actions.filter((a) => a.type === "spec" && a.status === "approved" && a.spec);
    const declined = actions.filter((a) => a.type === "spec" && a.status === "declined" && a.spec);
    if (!approved.length) {
      await recordDeclined(goalSlug, declined.map((a) => a.spec!));
      const acted = actions.map((a) => (a.status === "declined" ? { ...a, status: "done" as const, result: "recorded ❌" } : a));
      await update(job.id, { status: "completed", pending_actions: acted, log_tail: "no branches approved" });
      return;
    }

    const specList = approved
      .map((a, i) => {
        const s = a.spec!;
        return `${i + 1}. slug=${s.slug} · title="${s.title}" · owner=${s.owner} · parent="${s.parent}"${s.milestone ? ` · milestone=${s.milestone}` : ""}\n   intent: ${s.intent}${s.gap ? `\n   gap: ${s.gap}` : ""}`;
      })
      .join("\n");
    const declinedNote = declined.length
      ? `\n\nDECLINED branches (record as ❌ under a "## Declined branches" section in the goal doc so re-plan never re-proposes them): ${declined.map((a) => a.spec!.slug).join(", ")}.`
      : "";
    const prompt = [
      `Author the owner-APPROVED specs for goal docs/brain/goals/${goalSlug}.md (cwd is the repo root). Do NOT build anything; do NOT run git. Only write files under docs/brain/specs/ and edit docs/brain/goals/${goalSlug}.md.`,
      `For EACH approved spec below, create docs/brain/specs/{slug}.md as a real, concrete build spec: an H1 "# {Title} ⏳"; directly under it the metadata line \`**Owner:** [[../functions/{owner}]] · **Parent:** {parent}\`; a one-paragraph summary tied to the goal's success metric; concrete "## Phase N — name" sections (each first bullet "- ⏳ planned") grounded in the brain (read pages to cite real table/library names + the gap); a "## Safety / invariants" section; a "## Completion criteria" section. Match the style of existing docs/brain/specs/*.md.`,
      `Then update docs/brain/goals/${goalSlug}.md: under the matching milestone in "## Decomposition", add a wikilink to each new spec, e.g. "[[../specs/{slug}]] ⏳ — {one-line}".${declinedNote}`,
      ``,
      `Approved specs:\n${specList}`,
      ``,
      `Final message = ONLY {"status":"completed","summary":"authored N specs: …"} (or {"status":"needs_input","questions":[…]} only if a spec is genuinely under-specified).`,
    ].join("\n");

    const { session, resultText, isError } = await runClaude(prompt, job.claude_session_id, wt);
    if (session) await update(job.id, { claude_session_id: session });
    const parsed = parseStatus(resultText);
    console.log(`${tag} authoring finished — status: ${parsed?.status ?? "(none)"} isError=${isError}`);

    if (parsed?.status === "needs_input") {
      await update(job.id, { status: "needs_input", questions: parsed.questions ?? [] });
      return;
    }
    if (isError && !parsed) {
      await update(job.id, { status: "failed", error: "plan authoring errored" });
      return;
    }

    // Commit authored docs straight to main (specs/ + the goal doc only) so queued builds find them.
    const changed = sh("git", ["status", "--porcelain"], { cwd: wt }).out.trim()
      .split("\n").map((l) => l.trim().split(/\s+/).pop() || "").filter(Boolean);
    const docFiles = changed.filter((f) => f.startsWith("docs/brain/specs/") || f === `docs/brain/goals/${goalSlug}.md`);
    let committed = 0;
    for (const f of docFiles) {
      try {
        const content = readFileSync(join(wt, f), "utf8");
        const r = await putFileMain(f, content, `plan: ${goalSlug} → ${f.replace("docs/brain/", "")}`);
        if (r.ok) committed++;
        else console.error(`${tag} commit failed for ${f}: ${r.status}`);
      } catch (e) {
        console.error(`${tag} read/commit ${f}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Queue a build for each approved spec — the existing pipeline takes over (its own claude/* PR).
    const queuedSlugs: string[] = [];
    for (const a of approved) {
      const s = a.spec!;
      const { error } = await db.from("agent_jobs").insert({
        workspace_id: job.workspace_id,
        spec_slug: s.slug,
        kind: "build",
        status: "queued",
        instructions: `Authored by the goal planner for ${goalSlug} (${s.parent}).`,
        created_by: job.created_by,
      });
      if (!error) queuedSlugs.push(s.slug);
    }

    const acted = actions.map((a) =>
      a.type === "spec" && a.status === "approved"
        ? { ...a, status: "done" as const, result: queuedSlugs.includes(a.spec!.slug) ? "authored + build queued" : "authored" }
        : a.type === "spec" && a.status === "declined"
          ? { ...a, status: "done" as const, result: "recorded ❌" }
          : a,
    );
    await update(job.id, {
      status: "completed",
      pending_actions: acted,
      log_tail: `committed ${committed} docs to main; queued ${queuedSlugs.length} builds: ${queuedSlugs.join(", ")}`,
    });
    console.log(`${tag} ✓ authored ${approved.length} specs → queued ${queuedSlugs.length} builds`);
  } finally {
    sh("git", ["worktree", "remove", "--force", wt]);
  }
}

// ── Batch fold-build (fold-build-batching) ──────────────────────────────────
// A kind='fold' job folds EVERY pending-fold spec for its workspace into the brain in ONE branch/PR
// (instead of one build per spec). Runs in the concurrency-1 fold lane so it never races a feature
// build on the (now generated) index files. Each fold writes a per-spec docs/brain/archive.d/{slug}.md
// and runs scripts/brain-index.mjs to regenerate archive.md + README counts — no contended hand-edits.

async function setFoldRows(jobId: string, from: string, patch: Record<string, unknown>) {
  await db.from("pending_folds").update({ ...patch, updated_at: new Date().toISOString() }).eq("job_id", jobId).eq("status", from);
}

function foldBatchPrompt(slugs: string[]): string {
  const slugList = slugs.map((s) => `- docs/brain/specs/${s}.md`).join("\n");
  return [
    `BATCH FOLD-BUILD — fold these owner-verified, shipped specs into the brain and retire them, all in ONE branch. The owner has confirmed each works in production. This is DOCS-ONLY: do NOT rebuild or change any product code.`,
    ``,
    `Specs to fold:`,
    slugList,
    ``,
    `For EACH spec above, follow docs/brain/project-management.md "Folding a shipped spec into the brain":`,
    `1. Confirm the spec's durable knowledge is already folded into its permanent brain homes (the relevant lifecycles/ table(s)/ libraries/ inngest/ integrations/ dashboard/ recipes/ pages, each with a "Status / open work" block where applicable). If anything is missing, fold it now and cross-link it (3-5 wikilinks, linked FROM at least one existing page).`,
    `2. Create docs/brain/archive.d/{slug}.md containing EXACTLY ONE line — the per-spec archive entry. archive.md is GENERATED from this directory, so NEVER hand-edit docs/brain/archive.md. Use exactly this shape:`,
    `     - **<the spec's real title>** · verified <today's date — run \`date +%F\`> · → [[lifecycles/<the feature's primary lifecycle or brain home slug>]]`,
    `3. \`git rm docs/brain/specs/{slug}.md\` — git history is the immutable archive; a deleted spec is always \`git show\`-recoverable.`,
    ``,
    `Then ONCE for the whole batch:`,
    `4. Do NOT run brain-index.mjs, and do NOT modify docs/brain/archive.md or docs/brain/README.md. The board reads docs/brain/archive.d/ directly (getArchive), so committing the regenerated aggregates inside a fold PR is needless AND the #1 cause of fold PRs going Dirty — every fold re-edits the same archive.md/README lines, so a second fold conflicts the moment the first merges. Your PR should touch ONLY: the per-spec docs/brain/archive.d/{slug}.md file(s), the git-rm'd spec file(s), and any brain pages you folded into. The aggregates are refreshed out-of-band.`,
    `5. \`npx tsc --noEmit\` (should be a no-op — docs only).`,
    ``,
    `If you cannot determine where a spec's knowledge belongs (no obvious lifecycle/brain home), do NOT guess: still fold the others, and surface that one as a needs_input question naming the slug.`,
    ``,
    `Worker protocol: do NOT run git commit/push or open a PR (the worker owns version control); \`git rm\` to stage spec deletions is fine. Final message = ONLY one JSON object: {"status":"completed","summary":"folded N specs: …"} | {"status":"needs_input","questions":[{"id","q"}]}.`,
  ].join("\n");
}

async function runFoldJob(job: Job) {
  const isResume = !!job.claude_session_id;
  const tag = `[fold:${job.id.slice(0, 8)}]`;
  const wt = join(BUILDS_DIR, job.id);

  // Snapshot the batch. Fresh run: atomically claim every 'pending' spec for this workspace → 'folding'
  // bound to this job (specs verified after this point ride the NEXT queued fold job). Resume: re-read
  // the specs already bound to this job.
  let slugs: string[];
  if (isResume) {
    const { data } = await db.from("pending_folds").select("spec_slug").eq("job_id", job.id).eq("status", "folding");
    slugs = ((data ?? []) as { spec_slug: string }[]).map((r) => r.spec_slug);
  } else {
    const { data } = await db
      .from("pending_folds")
      .update({ status: "folding", job_id: job.id, updated_at: new Date().toISOString() })
      .eq("workspace_id", job.workspace_id)
      .eq("status", "pending")
      .select("spec_slug");
    slugs = ((data ?? []) as { spec_slug: string }[]).map((r) => r.spec_slug);
  }
  console.log(`${tag} ${isResume ? "resuming" : "folding"} ${slugs.length} spec(s): ${slugs.join(", ") || "(none)"}`);
  if (!slugs.length) {
    await update(job.id, { status: "completed", log_tail: "no pending-fold specs; nothing to fold" });
    return;
  }

  sh("git", ["fetch", "origin"]);
  let branch = job.spec_branch;
  sh("git", ["worktree", "remove", "--force", wt]);
  if (!isResume) {
    branch = `claude/fold-${Date.now().toString(36)}`;
    const add = sh("git", ["worktree", "add", "-B", branch, wt, "origin/main"]);
    if (add.code !== 0) throw new Error(`worktree add failed: ${add.err.slice(0, 300)}`);
    await update(job.id, { spec_branch: branch });
  } else {
    let add = sh("git", ["worktree", "add", "-B", branch!, wt, `origin/${branch}`]);
    if (add.code !== 0) add = sh("git", ["worktree", "add", "-B", branch!, wt, "origin/main"]);
    if (add.code !== 0) throw new Error(`worktree add (resume) failed: ${add.err.slice(0, 300)}`);
  }
  sh("ln", ["-sfn", join(REPO_DIR, "node_modules"), join(wt, "node_modules")]);

  try {
    const prompt = isResume
      ? `${(job.answers || []).length ? `Answers to your questions: ${JSON.stringify(job.answers)}. ` : ""}Continue the batch fold-build for specs: ${slugs.join(", ")}. Same rules and the same final JSON output protocol as before.`
      : foldBatchPrompt(slugs);

    const { session, resultText, isError, raw } = await runClaude(prompt, job.claude_session_id, wt);
    const logTail = raw.slice(-2000);
    if (session) await update(job.id, { claude_session_id: session });
    const parsed = parseStatus(resultText);
    console.log(`${tag} claude finished — parsed status: ${parsed?.status ?? "(none)"} isError=${isError}`);

    const prBody = `Batch fold-build by the box worker — folds ${slugs.length} owner-verified spec(s) into the brain and retires them:\n${slugs.map((s) => `- \`${s}\``).join("\n")}\n\narchive.md + README counts regenerated via \`scripts/brain-index.mjs\`. See docs/brain/specs/fold-build-batching.md.`;

    if (parsed?.status === "needs_input") {
      if (sh("git", ["status", "--porcelain"], { cwd: wt }).out.trim()) {
        sh("git", ["add", "-A"], { cwd: wt });
        sh("git", ["commit", "-m", `wip: fold-batch (needs input)`], { cwd: wt });
        sh("git", ["push", "-u", "origin", branch!], { cwd: wt });
      }
      const pr = await ensurePr(branch!, "fold-batch", true, prBody);
      await update(job.id, { status: "needs_input", questions: parsed.questions ?? [], log_tail: logTail, pr_url: pr?.url ?? null, pr_number: pr?.number ?? null });
      return; // specs stay 'folding' bound to this job → re-read on resume
    }

    if (isError && !parsed) {
      await setFoldRows(job.id, "folding", { status: "pending", job_id: null }); // release for the next batch
      await update(job.id, { status: "failed", error: "claude run errored", log_tail: logTail });
      return;
    }

    const tsc = await shAsync("npx", ["tsc", "--noEmit"], { timeout: 10 * 60 * 1000, cwd: wt });
    if (tsc.code !== 0) {
      await setFoldRows(job.id, "folding", { status: "pending", job_id: null });
      await update(job.id, { status: "failed", error: "tsc failed", log_tail: (tsc.out + tsc.err).slice(-2000) });
      return;
    }

    const dirty = sh("git", ["status", "--porcelain"], { cwd: wt }).out.trim();
    if (!dirty) {
      // Nothing changed — likely already folded. Treat as done so specs don't loop.
      await setFoldRows(job.id, "folding", { status: "folded" });
      // A fold can pause on needs_input → draft PR; un-draft it on a no-new-change resume (same gap as runJob).
      const pr = await ensurePr(branch!, slugs[0] || "fold", false);
      if (pr) {
        await markReady(pr.number);
        await update(job.id, { status: "completed", pr_url: pr.url, pr_number: pr.number, log_tail: "no new changes; un-drafted existing PR" });
      } else {
        await update(job.id, { status: "completed", log_tail: "no file changes; specs already folded" });
      }
      return;
    }
    sh("git", ["add", "-A"], { cwd: wt });
    const commit = sh("git", ["commit", "-m", `fold: ${slugs.length} spec(s)\n\n${slugs.join(", ")}`], { cwd: wt });
    if (commit.code !== 0) {
      await setFoldRows(job.id, "folding", { status: "pending", job_id: null });
      await update(job.id, { status: "failed", error: "git commit failed", log_tail: (commit.out + commit.err).slice(-2000) });
      return;
    }
    const push = sh("git", ["push", "-u", "origin", branch!], { cwd: wt });
    if (push.code !== 0) {
      await setFoldRows(job.id, "folding", { status: "pending", job_id: null });
      await update(job.id, { status: "failed", error: "git push failed", log_tail: push.err.slice(-2000) });
      return;
    }
    const pr = await ensurePr(branch!, "fold-batch", false, prBody);
    if (!pr) {
      await update(job.id, { status: "needs_attention", error: "branch pushed but PR creation failed", log_tail: logTail });
      return;
    }
    await markReady(pr.number);
    await setFoldRows(job.id, "folding", { status: "folded" });
    await update(job.id, { status: "completed", pr_url: pr.url, pr_number: pr.number, log_tail: logTail });
    console.log(`${tag} ✓ completed → ${pr.url}`);
  } finally {
    sh("git", ["worktree", "remove", "--force", wt]);
  }
}

// ── Box-driven product seeding (box-product-seeding) ─────────────────────────
// A kind='product-seed' job re-hosts the Product Intelligence Engine on the box,
// ON MAX: it launches a TOP-LEVEL `claude -p` (web search enabled, no
// ANTHROPIC_API_KEY) running the `seed-product` skill, which drives ONE product
// none → published. The skill does ALL the LLM work agentically (ingredient/
// benefit research by SEARCHING THE WEB, review analysis, benefit triangulation,
// content authoring, hero vision-QA) and reaches the DB / Drive / Gemini ONLY
// through the deterministic CLI scripts/seed-product-tools.ts. NEVER the Anthropic
// API, NEVER Inngest (the Inngest/UI Engine is a SEPARATE API path). No worktree
// / PR — this mutates DB + storage, not the repo, so it runs in the main repo dir.
// Params are carried on the job: spec_slug = product_id; instructions = JSON
// {product_id, workspace_id?, angle_override?}. See docs/brain/specs/box-product-seeding.md.
async function runProductSeedJob(job: Job) {
  const tag = `[seed:${job.id.slice(0, 8)}]`;
  let params: { product_id?: string; angle_override?: string | null; mode?: string } = {};
  try {
    params = job.instructions ? JSON.parse(job.instructions) : {};
  } catch {
    /* instructions weren't JSON — fall back to spec_slug as the product_id */
  }
  const productId = params.product_id || job.spec_slug;
  if (!productId) {
    await update(job.id, { status: "failed", error: "product-seed job missing product_id" });
    return;
  }
  const isResume = !!job.claude_session_id;
  // media-refresh: re-run ONLY the image stages (hero + lifestyle + ingredient
  // images) on an already-published product, skipping web research/reviews/content.
  const isMediaRefresh = params.mode === "media-refresh";
  // content-refresh (round-3 lander refinements): re-author content (punchier
  // headlines + comparison rows/competitor label + survey flag) AND refresh the
  // chapter images, KEEPING the existing research/reviews/benefits. For re-running
  // already-published products whose landers need the round-3 treatment.
  const isContentRefresh = params.mode === "content-refresh";
  // refinement (pdp-refinement-pass, round-4): the FULL per-product polish pass on an
  // already-published product — KEEP research/reviews/benefits, but re-author any pending
  // copy fixes AND run SKILL §6d (harvest REAL endorsements + before/after from the live
  // Shopify PDP w/ re-hosted images, lifestyle + Nano-Banana static-ad gallery slides,
  // per-variant supplement_facts) + a full-corpus 4★+ review re-analysis. Per-product
  // creative + (verified) nutrition + captions are read from docs/brain/specs/pdp-refinement-pass.md.
  const isRefinement = params.mode === "refinement";
  console.log(
    `${tag} ${isResume ? "resuming" : isRefinement ? "refinement-pass" : isMediaRefresh ? "media-refreshing" : isContentRefresh ? "content-refreshing" : "seeding"} product ${productId} on Max (job ${job.id})`,
  );

  const prompt = isResume
    ? `Resuming. Continue the product-seed for product_id=${productId} (workspace_id=${job.workspace_id}) and finish. Same rules and the same final JSON output protocol as before.`
    : isRefinement
      ? [
          `Use the seed-product skill to run the REFINEMENT PASS (docs/brain/specs/pdp-refinement-pass.md) on the already-published product_id=${productId} (workspace_id=${job.workspace_id}) (cwd is the repo root).`,
          `Params: { "product_id": "${productId}", "workspace_id": "${job.workspace_id}", "mode": "refinement" }`,
          `FIRST read docs/brain/specs/pdp-refinement-pass.md — its "Run #1 — Superfood Tabs" section carries the founder-LOCKED per-product inputs (punchy headline, the 16→15-superfoods copy fix EXCEPT the "12–16 oz water" dosing line, the FOUNDER-VERIFIED per-variant supplement_facts with Peach Mango prioritized, and the static-ad caption overlays). Apply those verbatim for Superfood Tabs.`,
          `KEEP existing research/reviews/benefit selections (do NOT redo steps 1–4). Then: (1) re-author page content with the pending copy fixes; (2) run §6d — harvest the REAL nutritionist endorsements + up to 2 before/after stories from the live Shopify PDP and re-host EVERY image to Supabase via rehost-image (never hotlink; these REPLACE any fabricated endorsements/avatars); add the 4-slide hero gallery (resolve-lifestyle + generate-static-ad with the locked captions); (3) populate per-variant product_variants.supplement_facts using the spec's VERIFIED values (this product IS founder-verified per the spec — populate + publish them); (4) re-run review analysis over the FULL 4★+ corpus (paginate get-reviews, NO 1000/2000 cap, featured-first) so the category counts are real.`,
          `Honor the locked-hero guard (never regenerate amazing-coffee / -pods / -creamer bag heroes; gallery lifestyle/static-ad slides are still allowed). Reach DB / Drive / Gemini ONLY through scripts/seed-product-tools.ts. You are on Max — never call the Anthropic API; never spawn a nested claude. Re-publish at the end.`,
          `Final message = ONLY one JSON object: {"status":"completed","summary":"…"} | {"status":"needs_attention","summary":"…"}.`,
        ].join("\n")
    : isContentRefresh
      ? [
          `Use the seed-product skill in CONTENT-REFRESH mode for product_id=${productId} (workspace_id=${job.workspace_id}) (cwd is the repo root).`,
          `Params: { "product_id": "${productId}", "workspace_id": "${job.workspace_id}", "mode": "content-refresh" }`,
          `KEEP the existing research, reviews, and benefit selections (do NOT redo steps 1–4). Re-author ONLY the page content with the round-3 refinements — punchier benefit-first hero headline, comparison_table_rows + comparison_competitor_label for the RIGHT rival, and show_survey (true ONLY for coffee) — then refresh the chapter images (hero + lifestyle_1 + timeline_N if the timeline renders + ingredient_{name}). Do NOT generate endorsement avatar faces. Reach the DB / Drive / Gemini ONLY through scripts/seed-product-tools.ts. You are on Max — never call the Anthropic API; never spawn a nested claude.`,
          `Honor the locked-hero guard: never regenerate amazing-coffee / amazing-coffee-pods / amazing-creamer heroes. Vision-QA any hero you generate. Re-publish the refreshed content version at the end.`,
          `Final message = ONLY one JSON object: {"status":"completed","summary":"…"} | {"status":"needs_attention","summary":"…"}.`,
        ].join("\n")
    : isMediaRefresh
      ? [
          `Use the seed-product skill in MEDIA-REFRESH mode for product_id=${productId} (workspace_id=${job.workspace_id}) (cwd is the repo root).`,
          `Params: { "product_id": "${productId}", "workspace_id": "${job.workspace_id}", "mode": "media-refresh" }`,
          `Re-run ONLY the image stages (step 6 hero + lifestyle + step 6b ingredient_{name} images). DO NOT re-do web research, reviews, benefits, or content, and do NOT change intelligence_status. Reach the DB / Drive / Gemini ONLY through scripts/seed-product-tools.ts. You are on Max — never call the Anthropic API; never spawn a nested claude.`,
          `Honor the locked-hero guard: never regenerate amazing-coffee / amazing-coffee-pods / amazing-creamer heroes (still allowed to add their ingredient_{name} images). Vision-QA any hero you generate.`,
          `Final message = ONLY one JSON object: {"status":"completed","summary":"…"} | {"status":"needs_attention","summary":"…"}.`,
        ].join("\n")
      : [
          `Use the seed-product skill to drive product_id=${productId} (workspace_id=${job.workspace_id}) from intelligence_status none → published (cwd is the repo root).`,
          `Params: { "product_id": "${productId}", "workspace_id": "${job.workspace_id}"${params.angle_override ? `, "angle_override": ${JSON.stringify(params.angle_override)}` : ""} }`,
          `You are on Max with web search enabled and NO ANTHROPIC_API_KEY — do the ingredient/benefit research by SEARCHING THE WEB (with real citations), and reach the DB / Drive / Gemini ONLY through scripts/seed-product-tools.ts. Never call the Anthropic API; never spawn a nested claude.`,
          `Self-QA before publishing; if QA fails or required data is missing, HOLD (do NOT publish) and surface why. Approved heroes (Amazing Coffee / pods / Creamer) are never overwritten — skip their image gen.`,
          `Final message = ONLY one JSON object: {"status":"completed","summary":"…"} | {"status":"needs_attention","summary":"…"}.`,
        ].join("\n");

  try {
    const { session, resultText, isError, raw } = await runSeedClaude(prompt, job.claude_session_id, REPO_DIR);
    if (session) await update(job.id, { claude_session_id: session });
    const parsed = parseStatus(resultText);
    const summary = parsed && typeof parsed.summary === "string" ? parsed.summary : "";
    // Supervision hook: post the skill's run summary + reasoning back on the job.
    const logTail = (summary || raw).slice(-2000);
    console.log(`${tag} claude finished — status: ${parsed?.status ?? "(none)"} isError=${isError}`);

    if (parsed?.status === "completed") {
      await update(job.id, { status: "completed", log_tail: logTail, error: null });
    } else if (parsed?.status === "needs_attention") {
      // Held (QA fail / missing data / publish error) — surface for the owner;
      // the Engine UI is the override surface. Not a crash.
      await update(job.id, { status: "needs_attention", log_tail: logTail, error: summary || "held before publish" });
    } else if (isError) {
      await update(job.id, { status: "failed", error: "seed run errored", log_tail: raw.slice(-2000) });
    } else {
      // No recognizable status — surface rather than assume published.
      await update(job.id, { status: "needs_attention", log_tail: logTail, error: "seed ended without a completed/needs_attention status" });
    }
    console.log(`${tag} ✓ ${parsed?.status ?? "(no status)"}`);
  } catch (e) {
    await update(job.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    console.error(`${tag} failed:`, e instanceof Error ? e.message : e);
  }
}

// ── Box-hosted spec chat (box-spec-chat) ────────────────────────────────────
// The roadmap authoring chat moved off the Anthropic API onto the box as a long-running, resumable
// `claude -p` session on Max. A kind='spec-chat' job is ONE user turn (or a finalize/verify). The
// thread itself is the roadmap_chats row (messages + box_session_id + turn_status). The route enqueues
// the turn; here we resume the SAME box session so the model keeps the full accumulated context plus
// live working-tree Read/Grep/Glob over docs/brain/ + src/ and WebSearch — all on Max, $0 marginal.
//   instructions JSON = { mode: 'turn'|'finalize'|'verify', chat_id?, slug?, seedSlug?, queueBuild? }.
// The box GENERATES (LLM, on Max); the worker (this deterministic Node code, holding the GH token +
// DB admin) COMMITS the spec to main + queues the build — never the secret-stripped box session.

interface ChatRow {
  id: string;
  spec_slug: string | null;
  messages: { role: "user" | "assistant"; content: string }[];
  box_session_id: string | null;
}
async function loadChatRow(chatId: string): Promise<ChatRow | null> {
  const { data } = await db
    .from("roadmap_chats")
    .select("id, spec_slug, messages, box_session_id")
    .eq("id", chatId)
    .maybeSingle();
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const msgs = Array.isArray(row.messages) ? (row.messages as { role: "user" | "assistant"; content: string }[]) : [];
  return { id: row.id as string, spec_slug: (row.spec_slug as string | null) ?? null, messages: msgs, box_session_id: (row.box_session_id as string | null) ?? null };
}

// Render the transcript as plain text for a fresh box session (turn 1 / a chat migrated from the old
// API flow that has history but no box_session_id yet). On resume we pass ONLY the new user message.
function renderTranscript(messages: ChatRow["messages"]): string {
  return messages.map((m) => `${m.role === "user" ? "[Founder]" : "[You]"}: ${m.content}`).join("\n\n");
}

const SPEC_CHAT_OUTPUT = `Final message = ONLY one JSON object, nothing else: {"status":"replied","reply":"<your plain-text conversational answer to the founder>"}.`;

function specChatFraming(slug?: string, seedSlug?: string): string {
  const ground = slug
    ? `You are REFINING the existing spec docs/brain/specs/${slug}.md — Read it from the working tree first as grounding; preserve shipped (✅) phases unless told otherwise.`
    : seedSlug
      ? `You are drafting a NEW spec by RE-HYDRATING from the current brain page docs/brain/${seedSlug}.md — Read it first as the source of truth for what exists TODAY, then help shape a fresh spec that EXTENDS or FIXES it (never restate a stale snapshot). Inherit the owner/parent taxonomy where sensible.`
      : `This is a NEW-feature chat (no existing spec).`;
  return [
    `Use the spec-chat skill to spec a ShopCX feature WITH the founder (Dylan). ${ground}`,
    `Brain-first per the house rule: Read docs/brain/ before grepping src/; Read the real src/ tree to ground specifics; WebSearch competitors/libraries when it helps. Respond as plain conversational prose (no markdown fluff). Do NOT edit files in this turn.`,
  ].join("\n");
}

async function runSpecChatJob(job: Job) {
  const tag = `[spec-chat:${job.id.slice(0, 8)}]`;
  let params: { mode?: string; chat_id?: string; slug?: string; seedSlug?: string; queueBuild?: boolean } = {};
  try {
    params = job.instructions ? JSON.parse(job.instructions) : {};
  } catch {
    /* not JSON — fall back to a plain turn keyed by spec_slug */
  }
  const mode = (params.mode as "turn" | "finalize" | "verify") || "turn";
  const chatId = params.chat_id || (mode !== "verify" ? job.spec_slug : undefined);
  const refineSlug = typeof params.slug === "string" ? params.slug : undefined;
  const seedSlug = typeof params.seedSlug === "string" ? params.seedSlug : undefined;

  // Mark the thread errored + the job failed (turn/finalize). verify has no thread to update.
  const failTurn = async (reason: string, logTail?: string) => {
    if (chatId) {
      await db.from("roadmap_chats").update({ turn_status: "error", last_error: reason.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", chatId);
    }
    await update(job.id, { status: "failed", error: reason, log_tail: logTail ?? null });
  };

  // Load the thread (turn/finalize). verify is standalone (Reads the committed spec; no thread needed).
  let chat: ChatRow | null = null;
  if (chatId) {
    chat = await loadChatRow(chatId);
    if (!chat) {
      await failTurn("chat thread not found");
      return;
    }
  }
  const sessionId = chat?.box_session_id ?? null;
  const isResume = !!sessionId;
  console.log(`${tag} ${mode} ${isResume ? "(resume)" : "(fresh)"} chat=${chatId ?? "—"} slug=${refineSlug ?? params.slug ?? "—"}`);

  // Stable per-chat (or per-verify-slug) worktree path so `claude --resume` finds the cwd-scoped session
  // across turns; recreated on origin/main each turn so brain/code reads are current. Tear down after.
  const key = (chatId || `verify-${params.slug || job.spec_slug}`).replace(/[^a-zA-Z0-9_-]/g, "");
  const wt = join(BUILDS_DIR, `spec-chat-${key}`);
  sh("git", ["fetch", "origin", "main"]);
  sh("git", ["worktree", "remove", "--force", wt]);
  const branch = `claude/spec-chat-${key}`;
  const add = sh("git", ["worktree", "add", "-B", branch, wt, "origin/main"]);
  if (add.code !== 0) {
    await failTurn(`worktree add failed: ${add.err.slice(0, 200)}`);
    return;
  }
  sh("ln", ["-sfn", join(REPO_DIR, "node_modules"), join(wt, "node_modules")]);

  try {
    // ── Build the per-mode prompt ──
    // finalize/verify: the box WRITES the spec file into the worktree (robust for large markdown — no
    // JSON-escaping fragility); the worker then reads the changed docs/brain/specs/*.md + commits it to
    // main (the runPlanJob pattern). turn: the box returns a short conversational reply as JSON.
    let prompt: string;
    if (mode === "verify") {
      const slug = params.slug || "";
      prompt = [
        `Use the spec-chat skill in VERIFY mode. Read docs/brain/specs/${slug}.md from the working tree and the brain pages it touches.`,
        `WRITE an updated docs/brain/specs/${slug}.md that inserts (or refreshes) ONLY a "## Verification" section — a concrete, prod-facing test checklist the OWNER follows to confirm the feature works in production. 3-7 bullets, each "- On {where}, {do what} → expect {observable result}" naming the REAL routes/tables/CLI the spec touched (look them up; never invent). No vague "test it works". Preserve everything else in the file byte-for-byte; put the section before "## Related" if present.`,
        `Do NOT edit any other file, do NOT run git. Final message = ONLY one JSON object: {"status":"verified","slug":"${slug}"}.`,
      ].join("\n");
    } else if (mode === "finalize") {
      const finalizeAsk = [
        `Now FINALIZE this spec in FINALIZE mode: WRITE the file docs/brain/specs/${refineSlug ? refineSlug : "{kebab-slug-from-the-title}"}.md into the working tree (create it; ${refineSlug ? `this is a refine — preserve shipped (✅) phases of the existing file unless the conversation said otherwise` : `pick a short kebab-case slug from the title; all new phases start ⏳`}).`,
        `It MUST have: an H1 "# <Title> <status emoji>"; directly under it the metadata line \`**Owner:** [[../functions/{slug}]] · **Parent:** {a function mandate or a goal milestone}\`; a one-paragraph summary tied to a business outcome; concrete "## Phase N — name" sections (each line tagged ⏳ planned · 🚧 in progress · ✅ shipped); a "## Safety / invariants" section; a "## Completion criteria" section; and a "## Verification" section (concrete prod-facing checklist).`,
        `Write ONLY that one file under docs/brain/specs/; do NOT edit anything else, do NOT run git. Final message = ONLY one JSON object: {"status":"finalized","slug":"<the slug you wrote>"}.`,
      ].join("\n");
      prompt = isResume
        ? finalizeAsk
        : [specChatFraming(refineSlug, seedSlug), ``, `Conversation so far:`, renderTranscript(chat!.messages), ``, finalizeAsk].join("\n");
    } else {
      // turn
      const latest = [...(chat?.messages ?? [])].reverse().find((m) => m.role === "user")?.content || "";
      prompt = isResume
        ? `${latest}\n\n${SPEC_CHAT_OUTPUT}`
        : [specChatFraming(refineSlug, seedSlug), ``, `Conversation so far:`, renderTranscript(chat!.messages), ``, `Respond to the latest [Founder] message. ${SPEC_CHAT_OUTPUT}`].join("\n");
    }

    // ── Run the box session (top-level Max claude; secrets stripped; WebSearch allowed) ──
    const { session, resultText, isError, raw } = await runClaude(prompt, sessionId, wt);
    const logTail = raw.slice(-2000);
    const newSession = session || sessionId;
    const parsed = parseStatus(resultText) as Record<string, unknown> | null;
    console.log(`${tag} claude finished — status: ${(parsed?.status as string) ?? "(none)"} isError=${isError}`);

    if (mode === "turn") {
      const reply = typeof parsed?.reply === "string" ? (parsed.reply as string) : "";
      if (!reply) {
        await failTurn("box turn returned no reply", logTail);
        return;
      }
      const fresh = await loadChatRow(chatId!); // re-read to append onto the latest transcript
      const messages = [...(fresh?.messages ?? chat!.messages), { role: "assistant" as const, content: reply }];
      await db.from("roadmap_chats").update({
        messages,
        box_session_id: newSession,
        turn_status: "idle",
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", chatId!);
      await update(job.id, { status: "completed", log_tail: logTail });
      console.log(`${tag} ✓ reply appended`);
      return;
    }

    // Discover the spec file the box wrote/edited in the worktree (the runPlanJob pattern). The model's
    // JSON slug is a hint; the changed file under docs/brain/specs/ is the source of truth.
    const changed = sh("git", ["status", "--porcelain"], { cwd: wt }).out.trim()
      .split("\n").map((l) => l.trim().split(/\s+/).pop() || "").filter(Boolean);
    const specFiles = changed.filter((f) => f.startsWith("docs/brain/specs/") && f.endsWith(".md"));

    if (mode === "verify") {
      const slug = params.slug || "";
      const target = `docs/brain/specs/${slug}.md`;
      if (!specFiles.includes(target)) {
        await failTurn(`box did not update ${target}`, logTail);
        return;
      }
      const content = readFileSync(join(wt, target), "utf8");
      const put = await putFileMain(target, content, `verification-guides: generate test plan for ${slug} (box spec-chat)`);
      if (!put.ok) {
        await failTurn(`commit failed (${put.status})`, logTail);
        return;
      }
      await update(job.id, { status: "completed", log_tail: `committed ## Verification to specs/${slug}.md` });
      console.log(`${tag} ✓ verification committed`);
      return;
    }

    // finalize — commit the one spec file the box wrote.
    const hintSlug = typeof parsed?.slug === "string" ? (parsed.slug as string).replace(/[^a-z0-9-]/gi, "") : "";
    const written =
      (refineSlug && specFiles.find((f) => f === `docs/brain/specs/${refineSlug}.md`)) ||
      (hintSlug && specFiles.find((f) => f === `docs/brain/specs/${hintSlug}.md`)) ||
      specFiles[0];
    if (!written) {
      await failTurn("box did not write a spec file", logTail);
      return;
    }
    const slug = written.replace(/^docs\/brain\/specs\//, "").replace(/\.md$/, "");
    const content = readFileSync(join(wt, written), "utf8");
    const put = await putFileMain(written, content, `spec: ${refineSlug ? "refine" : "create"} ${slug} (box spec-chat)`);
    if (!put.ok) {
      await failTurn(`commit failed (${put.status})`, logTail);
      return;
    }
    // Flip the thread finalized + link the slug, store the session, clear thinking.
    await db.from("roadmap_chats").update({
      status: "finalized",
      spec_slug: slug,
      box_session_id: newSession,
      turn_status: "idle",
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", chatId!);
    // Optionally queue the build — the existing pipeline takes over (its own claude/* PR).
    let queued = false;
    if (params.queueBuild) {
      const { error } = await db.from("agent_jobs").insert({
        workspace_id: job.workspace_id,
        spec_slug: slug,
        kind: "build",
        status: "queued",
        instructions: refineSlug ? "Refined via box spec-chat" : "Created via box spec-chat",
        created_by: job.created_by,
      });
      queued = !error;
    }
    await update(job.id, { status: "completed", log_tail: `finalized ${slug}${queued ? " + queued build" : ""}` });
    console.log(`${tag} ✓ finalized → specs/${slug}.md${queued ? " (build queued)" : ""}`);
  } finally {
    sh("git", ["worktree", "remove", "--force", wt]);
  }
}

// ── Box-hosted ticket Improve agent (box-ticket-improve) ─────────────────────
// A kind='ticket-improve' job is ONE turn of the ticket-bound Improve session. Like product-seed it
// runs a TOP-LEVEL `claude -p` on Max (web search on, ANTHROPIC_API_KEY unset → $0 marginal) and KEEPS
// the DB/crypto secrets — because the `ticket-improve` skill reaches the prod DB READ-ONLY through the
// deterministic scripts/improve-box-tools.ts CLI for live investigation. The box NEVER mutates: it
// investigates read-only + either replies or proposes a typed action plan. The plan is parked in
// ticket_improve_chats.pending_plan and EXECUTED server-side by the Vercel route on the founder's
// approval (it holds the prod write creds, exactly like today's Improve tab). No worktree / PR — this
// mutates a DB session row, not the repo, so it runs read-only in the main checkout (REPO_DIR).
// Params on the job: instructions = JSON {ticket_id, session_id, mode:'turn', user_message}.
async function runImproveClaude(prompt: string, sessionId: string | null, cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // stay on Max — never the Anthropic API
  const base = sessionId ? ["--resume", sessionId] : [];
  const args = [...base, "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json"];
  const r = await shAsync("claude", args, { cwd, env, timeout: IMPROVE_TIMEOUT_MS });
  let session = sessionId;
  let resultText = "";
  let isError = r.code !== 0;
  try {
    const obj = JSON.parse((r.out || "").trim());
    session = obj.session_id || session;
    resultText = typeof obj.result === "string" ? obj.result : JSON.stringify(obj);
    isError = isError || obj.is_error === true;
  } catch {
    resultText = (r.out || "") + (r.err || "");
  }
  return { session, resultText, isError, raw: (r.out || "") + (r.err || "") };
}

// Build the read-only context brief baked into turn 1 — so the box's FIRST reply already references
// THIS exact ticket's customer/order facts with no prompting (auto ticket-binding). Queried directly
// (the worker has DB creds); the box can fetch deeper/fresh data via the improve-box-tools CLI.
async function loadImproveBrief(ticketId: string): Promise<string> {
  const { data: ticket } = await db
    .from("tickets")
    .select("id, subject, status, channel, tags, escalation_reason, escalated_at, assigned_to, ai_turn_count, customer_id")
    .eq("id", ticketId)
    .single();
  if (!ticket) return `Ticket ${ticketId} not found.`;

  let customerLine = "No customer linked.";
  if (ticket.customer_id) {
    const { data: c } = await db
      .from("customers")
      .select("first_name, last_name, email, subscription_status, retention_score")
      .eq("id", ticket.customer_id)
      .single();
    if (c) {
      let ltv = "";
      try {
        const { getCustomerStats } = await import("../src/lib/customer-stats");
        const s = await getCustomerStats(ticket.customer_id);
        ltv = `, Orders: ${s.total_orders}, LTV: $${(s.ltv_cents / 100).toFixed(0)}`;
      } catch {
        /* LTV is best-effort — the brief is still useful without it */
      }
      customerLine = `${c.first_name || ""} ${c.last_name || ""} (${c.email}), Subscription: ${c.subscription_status || "none"}, Retention: ${c.retention_score ?? 0}${ltv}`;
    }
  }

  const { data: messages } = await db
    .from("ticket_messages")
    .select("direction, visibility, author_type, body, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true })
    .limit(50);
  const { data: analysis } = await db
    .from("ticket_analyses")
    .select("score, summary, created_at, window_end")
    .eq("ticket_id", ticketId)
    .order("window_end", { ascending: false })
    .limit(1)
    .maybeSingle();

  return [
    `Subject: ${ticket.subject}`,
    `Status: ${ticket.status} · Channel: ${ticket.channel} · Tags: ${(ticket.tags || []).join(", ") || "none"}`,
    `AI turns: ${ticket.ai_turn_count || 0}${ticket.escalated_at ? " · escalated" : ""}${ticket.assigned_to ? " · assigned to a human" : ""}`,
    ticket.escalation_reason ? `Escalation reason: ${ticket.escalation_reason}` : null,
    `Customer: ${customerLine}`,
    analysis ? `Latest AI quality analysis: ${analysis.score}/10 — ${analysis.summary || ""}` : "No ticket analysis yet.",
    "",
    `--- Ticket messages (last ${(messages || []).length}) ---`,
    ...(messages || []).map((m) => {
      const prefix = m.author_type === "ai" ? "[AI]" : m.author_type === "system" ? "[System]" : m.direction === "inbound" ? "[Customer]" : "[Agent]";
      const vis = m.visibility === "internal" ? " (internal note)" : "";
      return `${prefix}${vis}: ${String(m.body || "").replace(/<[^>]+>/g, " ").slice(0, 500)}`;
    }),
  ]
    .filter(Boolean)
    .join("\n");
}

interface SessionRow {
  id: string;
  workspace_id: string;
  ticket_id: string;
  box_session_id: string | null;
  messages: { role: string; content: string }[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizePlan(plan: any, ts: string): { summary: string; actions: any[] } | null {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.actions) || !plan.actions.length) return null;
  const KINDS = ["customer_action", "sonnet_prompt", "grader_rule", "rescore", "ticket_spec", "resolve_sequence"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions = plan.actions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((a: any) => a && typeof a === "object" && KINDS.includes(a.kind))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((a: any, i: number) => ({ ...a, id: `pa${ts}${i}`, status: "pending" }));
  if (!actions.length) return null;
  return { summary: String(plan.summary || "Proposed plan"), actions };
}

async function runTicketImproveJob(job: Job) {
  const tag = `[improve:${job.id.slice(0, 8)}]`;
  let params: { ticket_id?: string; session_id?: string; mode?: string; user_message?: string } = {};
  try {
    params = job.instructions ? JSON.parse(job.instructions) : {};
  } catch {
    /* fall through to the missing-params guard */
  }
  const ticketId = params.ticket_id;
  const sessionId = params.session_id;
  const userMessage = params.user_message || "";
  if (!ticketId || !sessionId) {
    await update(job.id, { status: "failed", error: "ticket-improve job missing ticket_id/session_id" });
    return;
  }

  const { data: sessionRaw } = await db.from("ticket_improve_chats").select("id, workspace_id, ticket_id, box_session_id, messages").eq("id", sessionId).single();
  const session = sessionRaw as SessionRow | null;
  if (!session) {
    await update(job.id, { status: "failed", error: "improve session not found" });
    return;
  }
  const setSession = (patch: Record<string, unknown>) =>
    db.from("ticket_improve_chats").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", sessionId);

  const isResume = !!session.box_session_id;
  console.log(`${tag} ${isResume ? "resuming" : "starting"} session ${sessionId.slice(0, 8)} on ticket ${ticketId.slice(0, 8)}`);

  try {
    const prompt = isResume
      ? [
          `New message from the human on ticket ${ticketId}: "${userMessage}"`,
          `Continue the conversation. Same role, same read-only-investigation rule, same final JSON output protocol ("reply" or "propose") as before.`,
        ].join("\n")
      : [
          `Use the ticket-improve skill (cwd is the repo root). You are the founder's CX co-pilot fixing ONE specific ticket, super-powered on Max.`,
          ``,
          `TICKET id ${ticketId} — full context loaded for you:`,
          await loadImproveBrief(ticketId),
          ``,
          `The human's message: "${userMessage}"`,
          ``,
          `For deeper/fresh READ-ONLY data, run: npx tsx scripts/improve-box-tools.ts <tool> ${ticketId} [json_input]`,
          `(tools: get_customer_account, get_returns, get_chargebacks, get_email_history, get_crisis_status, get_dunning_status, get_product_knowledge, get_ticket_analysis). You may also Read/Grep the brain + src/ and WebSearch.`,
          `Investigation is free + read-only. To ACT, propose a typed plan for approval — NEVER mutate anything yourself.`,
          ``,
          `Final message = ONLY one JSON object:`,
          `  {"status":"reply","message":"<plain-text reply / investigation answer, no actions>"}`,
          `  {"status":"propose","message":"<what you'll do + why>","plan":{"summary":"...","actions":[ ... ]}}`,
          `See the ticket-improve skill for the exact action shapes (customer_action, sonnet_prompt, grader_rule, rescore, ticket_spec, resolve_sequence).`,
        ].join("\n");

    const { session: boxSession, resultText, isError, raw } = await runImproveClaude(prompt, session.box_session_id, REPO_DIR);
    const parsed = parseStatus(resultText);
    console.log(`${tag} claude finished — status: ${parsed?.status ?? "(none)"} isError=${isError}`);

    if (boxSession && boxSession !== session.box_session_id) {
      await setSession({ box_session_id: boxSession });
    }

    const messages = Array.isArray(session.messages) ? session.messages : [];
    const ts = job.id.slice(0, 6);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = parsed as any;

    if (p?.status === "propose") {
      const plan = normalizePlan(p.plan, ts);
      const reply = String(p.message || "I've put together a plan for your approval.");
      if (plan) {
        await setSession({
          messages: [...messages, { role: "assistant", content: reply }],
          turn_status: "awaiting_approval",
          pending_plan: plan,
          last_error: null,
        });
      } else {
        // proposed but the plan was malformed/empty → treat as a plain reply, no parked plan
        await setSession({ messages: [...messages, { role: "assistant", content: reply }], turn_status: "idle", pending_plan: null, last_error: null });
      }
      await update(job.id, { status: "completed", log_tail: raw.slice(-2000) });
      return;
    }

    if (p?.status === "reply") {
      await setSession({
        messages: [...messages, { role: "assistant", content: String(p.message || "(no reply)") }],
        turn_status: "idle",
        pending_plan: null,
        last_error: null,
      });
      await update(job.id, { status: "completed", log_tail: raw.slice(-2000) });
      return;
    }

    // No recognizable status → surface as an error turn the UI can retry.
    await setSession({ turn_status: "error", last_error: "The box turn ended without a reply or plan. Try again." });
    await update(job.id, { status: isError ? "failed" : "needs_attention", error: "improve turn produced no reply/plan", log_tail: raw.slice(-2000) });
  } catch (e) {
    await setSession({ turn_status: "error", last_error: e instanceof Error ? e.message : String(e) });
    await update(job.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    console.error(`${tag} failed:`, e instanceof Error ? e.message : e);
  }
}

// ── Box-hosted escalation triage (box-escalation-triage) ─────────────────────
// A kind='triage-escalations' job is ONE hourly sweep of a workspace's routine-owned escalated tickets
// (escalated_at IS NOT NULL, escalated_to IS NULL). For each ticket the worker orchestrates a
// solver→skeptic→quorum loop as 2–4 SEPARATE top-level Max `claude -p` sessions — the skeptic is a
// fresh session (real adversarial double-check, not the solver re-grading itself). On quorum the worker
// (the only component with prod creds) materializes the agreed outputs: `pending` agent_todos for
// customer fixes, `proposed` sonnet_prompts for rule changes, committed spec files for code/analyzer
// fixes. No quorum → nothing materializes, the ticket stays escalated, and the disagreement is logged
// in triage_runs for a human. Like product-seed/ticket-improve this KEEPS the DB/crypto secrets (the
// passes investigate read-only via scripts/improve-box-tools.ts) and unsets ANTHROPIC_API_KEY (Max,
// $0 marginal). No worktree / PR — it mutates the DB + commits specs to main, not a feature branch.
// See docs/brain/specs/box-escalation-triage.md.
async function runTriageClaude(prompt: string, sessionId: string | null, cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // stay on Max — never the Anthropic API
  const base = sessionId ? ["--resume", sessionId] : [];
  const args = [...base, "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json"];
  const r = await shAsync("claude", args, { cwd, env, timeout: TRIAGE_PASS_TIMEOUT_MS });
  let session = sessionId;
  let resultText = "";
  let isError = r.code !== 0;
  try {
    const obj = JSON.parse((r.out || "").trim());
    session = obj.session_id || session;
    resultText = typeof obj.result === "string" ? obj.result : JSON.stringify(obj);
    isError = isError || obj.is_error === true;
  } catch {
    resultText = (r.out || "") + (r.err || "");
  }
  return { session, resultText, isError, raw: (r.out || "") + (r.err || "") };
}

const TRIAGE_TOOLS_LINE =
  "For deeper READ-ONLY data run: npx tsx scripts/improve-box-tools.ts <tool> <ticket_id> [json_input] " +
  "(tools: get_customer_account, get_returns, get_chargebacks, get_email_history, get_crisis_status, " +
  "get_dunning_status, get_product_knowledge, get_ticket_analysis). You may also Read/Grep the brain + src/ and WebSearch.";

function triageSolverPrompt(ticketId: string, brief: string): string {
  return [
    `Use the escalation-triage skill in SOLVER mode (cwd is the repo root). You are on Max, web search on, no API key.`,
    `This ticket was ESCALATED precisely because it slipped past every deterministic rule, every sonnet_prompt rule, AND the orchestrator. Your job: figure out WHY it escaped, then propose the fix that unescalates it — or, if it was escalated incorrectly, a spec to fix the analyzer.`,
    ``,
    `ESCALATED TICKET id ${ticketId} — full context:`,
    brief,
    ``,
    TRIAGE_TOOLS_LINE,
    `Investigation is free + read-only. You PROPOSE only — never mutate anything; the worker materializes after a skeptic agrees.`,
    ``,
    `Decide ONE decision and propose accordingly. See the escalation-triage skill for the exact action/payload shapes.`,
    `Final message = ONLY one JSON object (the SolverProposal): {"decision":"customer_fix|escalation_false_positive|analysis_gap|system_gap|no_action","reasoning":"why it escaped every rule","context_what_happened":"...","context_what_we_propose":"...","urgency":"urgent|normal|low","todos":[{"action_type":"customer_reply|customer_action|ticket_close|ticket_analysis_rescore","summary":"...","payload":{...},"confidence":0.0}],"spec":{"slug":"...","title":"...","intent":"...","problem":"...","target":"..."},"sonnet_prompt":{"title":"...","category":"rule","content":"..."}}`,
    `Include only the keys relevant to your decision (todos for customer_fix/no_action/analysis_gap; spec for escalation_false_positive/system_gap; sonnet_prompt optional).`,
  ].join("\n");
}

function triageSkepticPrompt(ticketId: string, brief: string, proposal: SolverProposal): string {
  return [
    `Use the escalation-triage skill in SKEPTIC mode (cwd is the repo root). You are a FRESH pair of eyes — not the solver. Try to REFUTE the solver, do not rubber-stamp.`,
    `Independently re-examine the ticket, the brain, the live rules (sonnet_prompts), and the DB settings to judge: is the issue correctly understood? Is the proposed fix correct, safe, and minimal? Would it actually unescalate this ticket (or correctly fix the analyzer)?`,
    ``,
    `ESCALATED TICKET id ${ticketId} — full context:`,
    brief,
    ``,
    `THE SOLVER PROPOSED:`,
    JSON.stringify(proposal, null, 2),
    ``,
    TRIAGE_TOOLS_LINE,
    `Investigate read-only, then judge. If the issue is misunderstood or the fix is wrong/unsafe → reject. If it's close but needs a bounded change → revise (give a concrete critique the solver can act on). Only agree if you genuinely could not refute it.`,
    `Final message = ONLY one JSON object: {"verdict":"agree|revise|reject","critique":"what's wrong / what to change / why you couldn't refute it","concerns":["..."]}`,
  ].join("\n");
}

function triageRevisePrompt(critique: string, concerns: string[]): string {
  return [
    `The skeptic did NOT agree and asked you to revise. Critique: ${critique}`,
    concerns.length ? `Concerns: ${concerns.map((c) => `- ${c}`).join("\n")}` : ``,
    `Incorporate this and emit a corrected SolverProposal — the SAME JSON shape and the same rules as before. If you now believe no safe fix exists, switch decision to "no_action" with an honest reasoning.`,
  ].filter(Boolean).join("\n");
}

async function runEscalationTriageJob(job: Job) {
  const tag = `[triage:${job.id.slice(0, 8)}]`;
  const wsId = job.workspace_id;
  const { selectEscalatedForTriage, loadTriageBrief, materializeTriageOutcome, recordTriageRun, handUpExhaustedTriage } = await import(
    "../src/lib/agent-todos/triage"
  );

  // No-quorum hand-up: tickets the routine has failed to resolve after the give-up cap are escalated
  // UP to a real human (escalated_to set) so they leave the routine pool and reach a person.
  const handedUp = await handUpExhaustedTriage(db, wsId);
  if (handedUp.length) console.log(`${tag} handed ${handedUp.length} no-quorum ticket(s) up to a human`);

  const sel = await selectEscalatedForTriage(db, wsId, TRIAGE_CAP);
  console.log(`${tag} ${sel.selected.length}/${sel.eligible} eligible escalated ticket(s) this sweep (deferred ${sel.deferred})`);
  if (!sel.selected.length) {
    await update(job.id, { status: "completed", log_tail: `no eligible escalated tickets (deferred ${sel.deferred})` });
    return;
  }

  const summaries: string[] = [];
  for (const ticketId of sel.selected) {
    const triageRunId = randomUUID();
    try {
      const brief = await loadTriageBrief(db, wsId, ticketId);

      // ── Solver (fresh session) ──
      let solver = await runTriageClaude(triageSolverPrompt(ticketId, brief), null, REPO_DIR);
      let proposal = extractJson<SolverProposal>(solver.resultText);
      if (!proposal || !proposal.decision) {
        await recordTriageRun(db, {
          id: triageRunId, workspaceId: wsId, jobId: job.id, ticketId, decision: null, verdict: "no_quorum",
          materialized: false, outcome: "solver produced no parseable proposal",
          solverTranscript: { raw: solver.raw.slice(-2000) }, skepticTranscript: null, groupId: null,
        });
        summaries.push(`${ticketId.slice(0, 8)}: solver-empty`);
        continue;
      }
      const solverSession = solver.session;

      // ── Skeptic (fresh eyes — separate session) ──
      let skeptic = await runTriageClaude(triageSkepticPrompt(ticketId, brief, proposal), null, REPO_DIR);
      let verdict = extractJson<SkepticVerdict>(skeptic.resultText);

      // ── One bounded re-loop on "revise" (solver incorporates critique; skeptic re-checks fresh) ──
      if (verdict?.verdict === "revise") {
        solver = await runTriageClaude(triageRevisePrompt(verdict.critique || "", verdict.concerns || []), solverSession, REPO_DIR);
        const revised = extractJson<SolverProposal>(solver.resultText);
        if (revised?.decision) proposal = revised;
        skeptic = await runTriageClaude(triageSkepticPrompt(ticketId, brief, proposal), null, REPO_DIR);
        verdict = extractJson<SkepticVerdict>(skeptic.resultText);
      }

      const v = verdict?.verdict;
      const finalVerdict: "agree" | "revise" | "reject" | "no_quorum" =
        v === "agree" || v === "revise" || v === "reject" ? v : "no_quorum";
      const solverTranscript = { proposal, raw: solver.raw.slice(-2000) };
      const skepticTranscript = { verdict: verdict?.verdict ?? null, critique: verdict?.critique ?? null, concerns: verdict?.concerns ?? null, raw: skeptic.raw.slice(-2000) };

      if (finalVerdict === "agree") {
        const mat = await materializeTriageOutcome(db, { workspaceId: wsId, ticketId, proposal, triageRunId });
        await recordTriageRun(db, {
          id: triageRunId, workspaceId: wsId, jobId: job.id, ticketId, decision: proposal.decision, verdict: "agree",
          materialized: true, outcome: mat.summary, solverTranscript, skepticTranscript, groupId: mat.groupId ?? null,
        });
        summaries.push(`${ticketId.slice(0, 8)}: agree·${proposal.decision} → ${mat.summary}`);
        console.log(`${tag} ${ticketId.slice(0, 8)} AGREE (${proposal.decision}) → ${mat.summary}`);
      } else {
        const outcome = `no quorum (solver=${proposal.decision}, skeptic=${finalVerdict})${verdict?.critique ? `: ${verdict.critique.slice(0, 300)}` : ""}`;
        await recordTriageRun(db, {
          id: triageRunId, workspaceId: wsId, jobId: job.id, ticketId, decision: proposal.decision, verdict: finalVerdict,
          materialized: false, outcome, solverTranscript, skepticTranscript, groupId: null,
        });
        summaries.push(`${ticketId.slice(0, 8)}: ${finalVerdict}·${proposal.decision} (stays escalated)`);
        console.log(`${tag} ${ticketId.slice(0, 8)} NO-QUORUM (${finalVerdict}) — stays escalated`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await recordTriageRun(db, {
          id: triageRunId, workspaceId: wsId, jobId: job.id, ticketId, decision: null, verdict: "no_quorum",
          materialized: false, outcome: `error: ${msg}`, solverTranscript: null, skepticTranscript: null, groupId: null,
        });
      } catch { /* audit best-effort */ }
      summaries.push(`${ticketId.slice(0, 8)}: error ${msg.slice(0, 120)}`);
      console.error(`${tag} ${ticketId.slice(0, 8)} errored: ${msg}`);
    }
  }

  await update(job.id, {
    status: "completed",
    log_tail: `swept ${sel.selected.length} ticket(s); deferred ${sel.deferred}. ${summaries.join(" | ")}`.slice(-2000),
  });
  console.log(`${tag} ✓ swept ${sel.selected.length} ticket(s)`);
}

// A kind='spec-test' job is ONE non-destructive QA pass over a shipped-but-unverified spec's
// `## Verification` checklist (spec-test-agent). Like ticket-improve/triage it KEEPS the DB/crypto
// secrets (the agent probes prod read-only via scripts/spec-test-db-probe.ts, gh, vercel, GET hits) and
// unsets ANTHROPIC_API_KEY (Max, $0 marginal). No worktree / PR — it writes one spec_test_runs row and
// NEVER mutates prod or flips a spec verified/archived. See docs/brain/specs/spec-test-agent.md.
async function runSpecTestClaude(prompt: string, sessionId: string | null, cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // stay on Max — never the Anthropic API
  const base = sessionId ? ["--resume", sessionId] : [];
  const args = [...base, "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json"];
  const r = await shAsync("claude", args, { cwd, env, timeout: SPEC_TEST_TIMEOUT_MS });
  let session = sessionId;
  let resultText = "";
  let isError = r.code !== 0;
  try {
    const obj = JSON.parse((r.out || "").trim());
    session = obj.session_id || session;
    resultText = typeof obj.result === "string" ? obj.result : JSON.stringify(obj);
    isError = isError || obj.is_error === true;
  } catch {
    resultText = (r.out || "") + (r.err || "");
  }
  return { session, resultText, isError, raw: (r.out || "") + (r.err || "") };
}

type SpecTestCheck = { text: string; verdict: string; category?: string; evidence?: string; screenshot?: string };
type SpecTestSummary = { auto_pass: number; auto_fail: number; needs_human: number; inconclusive: number };

// The spec-test skill is contracted to emit ONLY the result JSON as its final message, fenced-or-last.
// In practice a Max session sometimes wraps it in prose, so we extract defensively: whole-message parse
// first, then the LAST fenced ```json block that parses, then a scan for the LAST balanced {...} that
// parses (tolerating leading AND trailing prose). Returns null only if nothing parses — the caller then
// re-prompts once and, failing that, records an honest `error` run (never a silent 0-check approved row).
function extractSpecTestResult(text: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const o = JSON.parse(s);
      return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(text.trim());
  if (whole) return whole;
  // Last fenced ```json block that parses (the contract says fenced JSON is the last thing in the message).
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const o = tryParse(fences[i][1].trim());
    if (o) return o;
  }
  // Scan for the LAST parseable balanced {...}: walk candidate close braces from the end, and for each,
  // candidate open braces from the start — the first hit is the outermost-latest object (skips prose braces).
  const opens: number[] = [];
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) opens.push(i);
  const closes: number[] = [];
  for (let i = text.indexOf("}"); i >= 0; i = text.indexOf("}", i + 1)) closes.push(i);
  for (let e = closes.length - 1; e >= 0; e--) {
    const end = closes[e];
    for (const start of opens) {
      if (start >= end) break;
      const o = tryParse(text.slice(start, end + 1));
      if (o) return o;
    }
  }
  return null;
}

// Normalize + re-derive the verdict/summary from the agent's checks so the stamp can never lie (e.g. the
// agent says "approved" but a check failed). The checks array is the ground truth; counts follow it.
// `issues` is driven ONLY by evidence-backed `fail`s (auto_fail>0) — a `fail` means the agent observed
// breakage (see the classification rule in the spec-test prompt/skill); `needs_human`/`inconclusive`
// never flip the verdict to `issues` and never become regressions. The summary guard holds: an
// empty/uncertain run (no `pass`) lands on `needs_human`, never `approved`.
function normalizeSpecTest(parsed: Record<string, unknown> | null): {
  agent_verdict: "approved" | "issues" | "needs_human";
  summary: SpecTestSummary;
  checks: SpecTestCheck[];
  report: string;
} {
  const rawChecks = Array.isArray(parsed?.checks) ? (parsed!.checks as unknown[]) : [];
  const checks: SpecTestCheck[] = rawChecks.map((c) => {
    const o = (c || {}) as Record<string, unknown>;
    const v = String(o.verdict || "inconclusive");
    const verdict = ["pass", "fail", "needs_human", "inconclusive"].includes(v) ? v : "inconclusive";
    return {
      text: String(o.text || "(unnamed check)"),
      verdict,
      category: o.category ? String(o.category) : undefined,
      evidence: o.evidence ? String(o.evidence) : undefined,
      // Browser checks (spec-test-deep-verification Phase 1) carry the evidence screenshot's storage path.
      screenshot: o.screenshot ? String(o.screenshot) : undefined,
    };
  });
  const summary: SpecTestSummary = {
    auto_pass: checks.filter((c) => c.verdict === "pass").length,
    auto_fail: checks.filter((c) => c.verdict === "fail").length,
    needs_human: checks.filter((c) => c.verdict === "needs_human").length,
    inconclusive: checks.filter((c) => c.verdict === "inconclusive").length,
  };
  const agent_verdict: "approved" | "issues" | "needs_human" =
    summary.auto_fail > 0 ? "issues" : summary.auto_pass > 0 ? "approved" : "needs_human";
  return { agent_verdict, summary, checks, report: String(parsed?.report || "") };
}

// runSpecTestJob — the box QA agent for ONE shipped-but-unverified spec (spec-test-agent Phase 1). Runs
// the spec-test skill on Max in the MAIN checkout (read-only; the shipped spec is on origin/main), then
// records a spec_test_runs row with the agent_verdict stamp + per-check verdict+evidence. NEVER opens a
// PR, NEVER mutates prod, NEVER marks the spec verified — the owner's verify gate stays untouched.
async function runSpecTestJob(job: Job) {
  const slug = job.spec_slug;
  const tag = `[spec-test:${slug}]`;
  console.log(`${tag} testing shipped spec (job ${job.id.slice(0, 8)})`);
  try {
    const prompt = [
      `Use the spec-test skill (cwd is the repo root). You are the box QA agent for ONE shipped-but-unverified spec, on Max — web search on, no API key.`,
      `The spec to test is docs/brain/specs/${slug}.md. Read it + its "## Verification" section, classify each bullet (auto-testable non-destructive | needs-human), and run ONLY the non-destructive checks on the box.`,
      `⭐ MANDATE — IF A MACHINE CAN TEST IT, THE MACHINE DOES IT. Maximize machine coverage; \`needs_human\` is the LAST resort, not the default. You have THREE non-destructive execution modes — reach for them in order before deferring: (1) read-only probes (repo/DB/HTTP/migration-present), (2) OUTCOME PROBE, (3) NON-DESTRUCTIVE LOCAL HARNESS.`,
      `OUTCOME-NOT-ACTION: a bullet shaped "do X (a mutation) → expect observable Y" — first ask: is Y ALREADY observable read-only? (a prod row already in the expected state from real traffic, a column already populated, a rendered context string on an existing order, a unique-index definition in pg_indexes). If yes → probe Y read-only and pass/fail on that evidence. Do NOT defer just because the ACTION X mutates — you verify the OUTCOME. Only when the observable requires YOU to perform an irreversible prod mutation that real traffic hasn't already produced → needs_human.`,
      `LOCAL HARNESS: when the logic under test is reachable as a pure function / parser / classifier / validator in src/, author a THROWAWAY local script (scratch, _-prefixed, NEVER committed) that imports it and exercises it locally — INCLUDING FAULT INJECTION (feed malformed payload, force unparseable output) — run it with \`npx tsx _spec-test-harness.ts\`. No prod write, no network side-effect → it's \`auto\`. Record the input you fed + the value/state returned as evidence. This converts the whole fault-injection bucket from needs_human to auto WHENEVER the logic is reachable as a local unit (e.g. "force unparseable output → error state" over a pure extractor: import it, feed garbage, assert the error state).`,
      `BROWSER CHECK (spec-test-deep-verification Phase 1) — a FOURTH non-destructive mode for RENDERED-UI bullets. A bullet asserting rendered DOM or a non-mutating click-flow ("the card shows the Agent-tested stamp + chip", "VerificationCard renders per-bullet verdicts", "composer textarea ≥5 rows / auto-grows", "a non-owner doesn't see the nav item / gets a 403", "open the tab → see X") is a BROWSER check (\`auto\`, pass/fail with a SCREENSHOT as evidence), NOT needs_human. Run it with \`npx tsx scripts/spec-test-browser-check.ts --path "/dashboard/..." [--role owner|anon] [--expect-status N] [--assert-text "..."]* [--assert-selector "css"]* [--assert-not-text "..."]* [--assert-no-selector "css"]* [--assert-redirect "/login"] [--click "css"]* [--wait-selector "css"] --slug ${slug} --label <short>\`. It mints an OWNER session server-side (service-role admin, NO human creds), loads the page authed, asserts, and uploads a screenshot to the private evidence bucket; its stdout JSON includes \`pass\`, the per-assertion results, and \`screenshot\` (a storage path). PUT that \`screenshot\` value into the check's \`"screenshot"\` field so the Developer page renders it, and the assertion results into \`evidence\`. (Workspace for this run: ${job.workspace_id} — the tool resolves it automatically, but you may pass \`--workspace-id ${job.workspace_id}\`.)`,
      `🚨 BROWSER GUARDRAIL — the browser session is OWNER-AUTHED but READ-ONLY on prod: navigate + assert + benign clicks (expand a section / open a tab) ONLY. NEVER use it to fill or submit a form that mutates real customer/billing data — a bullet whose verification REQUIRES a real mutation (submit → charges a card / sends a message / writes a real order) stays needs_human (or Phase 2's sandbox). Use \`--role anon\` for "unauthenticated/non-owner is gated → redirect to /login or 401/403".`,
      `\`needs_human\` is now EXACTLY TWO cases: (a) VISUAL/AESTHETIC judgment (looks good / renders nicely / big enough — human taste is the only instrument; a RENDERED-FACT assertion like "the stamp/chip is present" is a BROWSER check, not this), and (b) an IRREVERSIBLE PROD SIDE-EFFECT with NO already-observable evidence AND NO local-harness/browser equivalent (a real SMS/email/charge actually reaching an external carrier/processor, or a UI flow that can only be verified by submitting a real customer/billing mutation). Everything else attempts a non-destructive verification.`,
      `🚨 \`fail\` REQUIRES POSITIVE EVIDENCE OF BREAKAGE — you ran a non-destructive check (incl. a local harness) and OBSERVED the feature doing the wrong thing (a column it claims to select isn't there; a route 500s; a role check returns the wrong status; the harness returned the wrong state). "I couldn't verify this read-only" is NOT a fail. A fault-injection bullet is \`auto\` (pass/fail) whenever the logic is reachable as a local unit; only when it is NOT reachable locally (needs forcing a fault in a live prod runtime path, a mutation, or visual/UX judgment) is it \`needs_human\` (a human can verify it), NEVER \`fail\`. Genuinely undeterminable (missing fixture, ambiguous bullet) → \`inconclusive\`. When the code plainly satisfies a bullet but the runtime path needs a forced fault AND the logic isn't reachable locally, prefer \`needs_human\` with a note ("code present at file:line; not reachable as a local unit, needs forced fault to confirm") over \`fail\`. Only evidence-backed \`fail\`s become regressions / flip the verdict to \`issues\`; \`needs_human\`/\`inconclusive\` never do.`,
      `TIE-BREAKER (replaces "when in doubt → needs_human"): when in doubt, attempt a read-only outcome probe first, then a non-destructive local harness; defer to \`needs_human\` ONLY if BOTH are impossible.`,
      `You have the box's read-only QA toolkit: repo Read/Grep + \`npx tsc --noEmit\`, the \`gh\` CLI for CI/PR status, the \`vercel\` CLI for deploy READY + logs + \`vercel env ls\`, read-only DB probes via \`npx tsx scripts/spec-test-db-probe.ts "<select …>"\`, GET/read-only endpoint hits, a non-destructive local harness (\`_\`-prefixed scratch \`npx tsx\` script importing pure code from src/), and the headless-browser check \`npx tsx scripts/spec-test-browser-check.ts\` (owner-authed, READ-ONLY render assertions + screenshot). NEVER mutate prod, NEVER mark the spec verified/archived, NEVER run a mutating prod check (those are needs_human), NEVER submit a mutating form in the browser.`,
      `Final message = ONLY one JSON object (no prose before/after; if fenced, the JSON is the last thing in the message): {"status":"completed","agent_verdict":"approved|issues|needs_human","summary":{"auto_pass":N,"auto_fail":N,"needs_human":N,"inconclusive":N},"checks":[{"text":"<bullet>","verdict":"pass|fail|needs_human|inconclusive","category":"auto|needs_human|inconclusive","evidence":"<concrete proof>","screenshot":"<storage path from a browser check, or omit>"}],"report":"<2-4 plain-text sentences>"} — or {"status":"error","error":"<why>"} if you cannot proceed.`,
    ].join("\n");

    // Records the run as a distinct, retryable `error` state (NOT a 0-check approved/empty row): the
    // Developer page shows "Run errored — retry" with the raw tail, and "Test now" re-runs it.
    const writeErrorRun = async (reason: string, transcript: string, status: string, jobError?: string) => {
      await db.from("spec_test_runs").insert({
        workspace_id: job.workspace_id, spec_slug: slug, agent_job_id: job.id,
        agent_verdict: "error", summary: {}, checks: [],
        transcript: transcript.slice(-8000), error: reason,
      });
      await update(job.id, { status, error: jobError ?? reason, log_tail: transcript.slice(-2000) });
    };

    let { session, resultText, isError, raw } = await runSpecTestClaude(prompt, null, REPO_DIR);
    if (session) await update(job.id, { claude_session_id: session });
    let parsed = extractSpecTestResult(resultText);

    // Parse-repair: the contract is strict JSON, but a Max session occasionally returns prose. Re-prompt
    // ONCE on the same session for ONLY the JSON before giving up — a cheap self-heal that turns most
    // would-be "no parseable JSON" runs into real verdicts.
    if (!parsed) {
      console.log(`${tag} no parseable JSON on first pass — re-prompting once for strict JSON`);
      const repair = [
        `Your previous message could not be parsed as JSON. Return ONLY one valid JSON object matching this schema — no prose, no commentary, no markdown around it, and if fenced it must be the last thing in the message:`,
        `{"status":"completed","agent_verdict":"approved|issues|needs_human","summary":{"auto_pass":N,"auto_fail":N,"needs_human":N,"inconclusive":N},"checks":[{"text":"<bullet>","verdict":"pass|fail|needs_human|inconclusive","category":"auto|needs_human|inconclusive","evidence":"<concrete proof>","screenshot":"<storage path from a browser check, or omit>"}],"report":"<2-4 plain-text sentences>"}`,
        `Reuse the checks you already determined; do not re-run anything. If you genuinely could not proceed, return ONLY {"status":"error","error":"<why>"}.`,
      ].join("\n");
      const retry = await runSpecTestClaude(repair, session, REPO_DIR);
      if (retry.session) { session = retry.session; await update(job.id, { claude_session_id: session }); }
      resultText = retry.resultText; isError = retry.isError; raw = retry.raw;
      parsed = extractSpecTestResult(resultText);
    }

    console.log(`${tag} claude finished — status: ${parsed?.status ?? "(none)"} isError=${isError}`);

    if (parsed?.status === "error") {
      await writeErrorRun(String(parsed.error || "agent reported error"), raw, "completed", `spec-test error: ${String(parsed.error || "").slice(0, 300)}`);
      return;
    }

    if (!parsed) {
      // Still unparseable after the one repair pass — honest terminal `error` state, never a clean-pass row.
      await writeErrorRun("agent produced no parseable JSON (after one repair re-prompt)", raw, isError ? "failed" : "needs_attention", "spec-test produced no parseable JSON");
      return;
    }

    const { agent_verdict, summary, checks, report } = normalizeSpecTest(parsed);
    await db.from("spec_test_runs").insert({
      workspace_id: job.workspace_id, spec_slug: slug, agent_job_id: job.id,
      agent_verdict, summary, checks, transcript: raw.slice(-8000), error: null,
    });
    // spec-test-maximize-machine-coverage Phase 3: reflect the run's green (`pass`) checks onto the spec
    // markdown's verification bullets (leading ✅, committed to main). Best-effort — never fail the run.
    try {
      const { reflectSpecGreenChecks } = await import("../src/lib/spec-green-writeback");
      const g = await reflectSpecGreenChecks(job.workspace_id, slug);
      if (g.changed) console.log(`${tag} reflected ${g.greenCount}/${g.total} green checks onto ${slug}.md${g.allGreen ? " (all green)" : ""}`);
    } catch (e) {
      console.error(`${tag} green-check writeback failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
    await update(job.id, {
      status: "completed",
      log_tail: `${agent_verdict} — ✅${summary.auto_pass} ✗${summary.auto_fail} 👤${summary.needs_human} ?${summary.inconclusive}. ${report}`.slice(-2000),
    });
    console.log(`${tag} ✓ ${agent_verdict} — ✅${summary.auto_pass} ✗${summary.auto_fail} 👤${summary.needs_human} ?${summary.inconclusive}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await db.from("spec_test_runs").insert({
        workspace_id: job.workspace_id, spec_slug: slug, agent_job_id: job.id,
        agent_verdict: "error", summary: {}, checks: [], transcript: null, error: `error: ${msg}`,
      });
    } catch { /* audit best-effort */ }
    await update(job.id, { status: "failed", error: msg });
    console.error(`${tag} failed: ${msg}`);
  }
}

// ── Box-hosted migration-fix agent (migration-fix-agent) ─────────────────────
// A kind='migration-fix' job is fired by the EVENT hook in src/lib/migration-audit.ts the moment a
// migration_audits row transitions to `failed` (NOT a cron). Like ticket-improve/triage it runs a
// TOP-LEVEL `claude -p` on Max (no ANTHROPIC_API_KEY, web search on) and KEEPS the DB/crypto/Appstle
// secrets — but its mutations are GATED: the box DIAGNOSES the failing checks read-only and PROPOSES a
// typed fix plan (price reconcile / variant backfill / Appstle cancel); the owner approves on
// /dashboard/migrations; the WORKER (the only component that should mutate) executes the approved plan
// via src/lib/migration-fix.ts `applyMigrationFix`, then re-runs verifyMigration — only a re-`passed`
// audit clears. Unfixable (no card anywhere) → surfaced human-needed with the box's written diagnosis,
// the audit stays failed. spec_slug = the audit id; instructions = JSON {audit_id, subscription_id}.
// No worktree / PR — it mutates the sub/catalog/Appstle, not the repo. See docs/brain/specs/migration-fix-agent.md.
async function runMigrationFixClaude(prompt: string, sessionId: string | null, cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // stay on Max — never the Anthropic API
  const base = sessionId ? ["--resume", sessionId] : [];
  const args = [...base, "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json"];
  const r = await shAsync("claude", args, { cwd, env, timeout: MIGRATION_FIX_TIMEOUT_MS });
  let session = sessionId;
  let resultText = "";
  let isError = r.code !== 0;
  try {
    const obj = JSON.parse((r.out || "").trim());
    session = obj.session_id || session;
    resultText = typeof obj.result === "string" ? obj.result : JSON.stringify(obj);
    isError = isError || obj.is_error === true;
  } catch {
    resultText = (r.out || "") + (r.err || "");
  }
  return { session, resultText, isError, raw: (r.out || "") + (r.err || "") };
}

// Best-effort re-fetch of the OLD Appstle contract's lines (for the grandfathered-base inference the
// box reconciles against). Mirrors verifyAppstleCancelled's fetch; never throws (degrades to null).
async function fetchAppstleContractForBrief(workspaceId: string, appstleContractId: string): Promise<unknown | null> {
  if (!appstleContractId) return null;
  try {
    const { createAdminClient } = await import("../src/lib/supabase/admin");
    const { decrypt } = await import("../src/lib/crypto");
    const a = createAdminClient();
    const { data: ws } = await a.from("workspaces").select("appstle_api_key_encrypted").eq("id", workspaceId).maybeSingle();
    if (!ws?.appstle_api_key_encrypted) return null;
    const apiKey = decrypt(ws.appstle_api_key_encrypted);
    const r = await fetch(`https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${appstleContractId}?api_key=${apiKey}`, { headers: { "X-API-Key": apiKey }, cache: "no-store" });
    if (!r.ok) return { status: r.status === 404 ? "NOT_FOUND" : `http_${r.status}` };
    return await r.json().catch(() => null);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// Build the read-only brief baked into the fresh box session: the audit + failing checks, the sub + its
// items, the catalog variants for the sub's products (so the box can map a lingering Shopify id → UUID
// + see MSRP), the live engine pricing snapshot vs the captured pre-migration charge, and the live
// Appstle contract lines. The box needs no extra read tools — everything to compute a typed fix is here.
async function loadMigrationFixBrief(audit: Record<string, unknown>): Promise<string> {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const a = createAdminClient();
  const workspaceId = String(audit.workspace_id || "");
  const subId = String(audit.subscription_id || "");

  const { data: sub } = await a
    .from("subscriptions")
    .select("id, is_internal, status, shopify_contract_id, items, customer_id, payment_method_id, delivery_price_cents")
    .eq("id", subId)
    .maybeSingle();
  const items = (sub && Array.isArray(sub.items) ? sub.items : []) as Array<Record<string, unknown>>;

  // Catalog variants for the sub's products → so the box can resolve Shopify-id items + read MSRP.
  const productIds = [...new Set(items.map((i) => String(i.product_id || "")).filter(Boolean))];
  let catalog: Array<Record<string, unknown>> = [];
  if (productIds.length) {
    const { data: vars } = await a
      .from("product_variants")
      .select("id, product_id, shopify_variant_id, sku, title, price_cents")
      .eq("workspace_id", workspaceId)
      .in("product_id", productIds);
    catalog = (vars || []) as Array<Record<string, unknown>>;
  }

  // Live engine pricing snapshot (what the internal engine would charge now) vs the captured pre charge.
  let engineSubtotal: number | null = null;
  try {
    const { resolveSubscriptionPricing } = await import("../src/lib/pricing");
    const pricing = await resolveSubscriptionPricing(workspaceId, sub as Record<string, unknown>);
    engineSubtotal = pricing.product_subtotal_cents;
  } catch (e) {
    engineSubtotal = null;
    void e;
  }

  const appstle = await fetchAppstleContractForBrief(workspaceId, String(audit.appstle_contract_id || ""));
  const checks = Array.isArray(audit.checks) ? (audit.checks as Array<Record<string, unknown>>) : [];
  const failing = checks.filter((c) => c.ok === false);

  return [
    `AUDIT ${audit.id} — status ${audit.status} · retry ${audit.retry_count} · is_recovery ${audit.is_recovery}`,
    `  appstle_contract_id (old): ${audit.appstle_contract_id} → internal: ${audit.internal_contract_id}`,
    `  pre_migration_charge_cents: ${audit.pre_migration_charge_cents}  ·  engine product_subtotal now: ${engineSubtotal ?? "(unavailable)"}`,
    `  last_error: ${audit.last_error || "—"}`,
    ``,
    `FAILING CHECKS (${failing.length}):`,
    ...failing.map((c) => `  ❌ ${c.key} — ${c.detail || "fail"}`),
    `ALL CHECKS: ${checks.map((c) => `${c.ok ? "✅" : "❌"}${c.key}`).join(" ")}`,
    ``,
    `SUBSCRIPTION ${subId}: status ${sub?.status} · is_internal ${sub?.is_internal} · payment_method_id ${sub?.payment_method_id || "none"} · customer ${sub?.customer_id}`,
    `  items (${items.length}):`,
    ...items.map((i) => `    - variant_id=${i.variant_id} product_id=${i.product_id} sku=${i.sku ?? "—"} qty=${i.quantity ?? 1} title="${i.title ?? ""}" price_override_cents=${i.price_override_cents ?? "—"}`),
    ``,
    `CATALOG variants for these products (${catalog.length}):`,
    ...catalog.map((v) => `    - id=${v.id} shopify_variant_id=${v.shopify_variant_id ?? "—"} sku=${v.sku ?? "—"} price_cents=${v.price_cents} title="${v.title ?? ""}" product_id=${v.product_id}`),
    ``,
    `LIVE APPSTLE CONTRACT (old id ${audit.appstle_contract_id}):`,
    `${JSON.stringify(appstle)?.slice(0, 4000) || "null"}`,
  ].join("\n");
}

function migrationFixPrompt(audit: Record<string, unknown>, brief: string): string {
  return [
    `Use the migration-fix skill (cwd is the repo root). You are the box's billing-integrity agent on Max — web search on, no API key. You KEEP read access to prod, but you NEVER mutate: you DIAGNOSE + PROPOSE a typed fix plan; the worker executes it on the owner's approval, then re-runs verifyMigration.`,
    `A migration_audits row flipped to FAILED (a renewal at risk). Work each FAILING check and propose the judgment fix the mechanical auto-heal punts. Ground the inference by reading src/lib/appstle-pricing.ts (inferAppstleLineBase), src/lib/migrate-to-internal.ts, src/lib/pricing.ts, and src/lib/migration-audit.ts.`,
    ``,
    brief,
    ``,
    `Decide a fix for EACH failing check you can safely repair:`,
    `  • pricing_preserved mismatch → recompute the true grandfathered base (inferAppstleLineBase logic over the LIVE Appstle line: pricingPolicy.basePrice if present, else currentPrice/(1−sns)) and propose a price_reconcile that sets each grandfathered line's item.price_override_cents so the internal engine product_subtotal ≈ pre_migration_charge_cents (±2¢/line). payload: {"overrides":[{"variant_id":"<the catalog UUID on the sub item>","price_override_cents":<int>}]}.`,
    `  • items_on_uuids unresolved variant (an item points at a Shopify variant with NO product_variants row) → propose a variant_backfill that INSERTS the missing catalog row + remaps the item to the new UUID (never loosen the check). payload: {"variant":{"product_id":"<uuid>","shopify_variant_id":"<id>","title":"...","sku":"...","price_cents":<int>},"item_match":{"shopify_variant_id":"<id>","sku":"..."}}.`,
    `  • appstle_cancelled / no_double_bill (the old Appstle contract is still ACTIVE → double-bill risk) → propose an appstle_cancel. payload: {"appstle_contract_id":"<old id, defaults to the audit's>","reason":"migrated to shopcx"}.`,
    `  • card_pinned / no billable card → you CANNOT invent a card. This is OUT-OF-SYSTEM (the customer must act) → status "human_needed" with a ONE-LINE plain instruction, e.g. "Ask {customer} to add a card; this sub can't bill until then." NOT a check-jargon dump.`,
    ``,
    `Two human paths — pick the right one:`,
    `  • HUMAN-JUDGMENT (a decision YOU can't make but the OWNER can — e.g. an ambiguous grandfathered price, conflicting records, an unclear intended base) → DON'T dump check-jargon. Pause on status "needs_input" with ONE plain-language, actionable question that names the concrete choice and the specific values, e.g. "This customer's locked-in price is unclear — our records show $39 and $49 for their coffee. What should we bill per unit?" — NOT "pricing_preserved failed: engine subtotal ≠ pre_migration_charge ±2¢/line." Reuse the questions [{id,q}] shape. The owner answers inline on /dashboard/migrations and you'll be resumed WITH the answer to propose the concrete fix.`,
    `  • OUT-OF-SYSTEM (nothing the owner can type fixes it — e.g. no card anywhere) → status "human_needed" with a ONE-LINE plain instruction (no technical dump).`,
    ``,
    `CODE-GAP escalation: if the root cause is a RECURRING code/data gap — a CLASS of missing catalog rows (not just this sub's one variant), or a pricing-inference edge case inferAppstleLineBase can't cover — don't just hand it to a human one sub at a time. Status "code_gap": author a permanent fix spec so the box commits docs/brain/specs/{slug}.md (surfaced on Roadmap to commission a build, like box-escalation-triage routes analyzer fixes). Use a STABLE, gap-descriptive slug (NOT the sub/audit id — recurring failures must converge on ONE spec, e.g. "migration-variant-backfill-from-appstle"), so the same gap doesn't spawn a duplicate spec per sub. The migration still fails-closed to a human (the spec fixes the class, not this renewal) — put what to do for THIS sub in the diagnosis.`,
    ``,
    `If every failing check has a safe typed fix → status "propose" with the actions. If a failing check needs an owner DECISION → status "needs_input" with the plain question. If it's out-of-system → status "human_needed". If it's a recurring code/data gap → status "code_gap". Never propose a partial fix that re-bills blindly.`,
    ``,
    `Final message = ONLY one JSON object:`,
    `  {"status":"propose","diagnosis":"<plain-text: what failed + what each fix does + the numbers>","actions":[{"fix_kind":"price_reconcile|variant_backfill|appstle_cancel","summary":"<one line>","preview":"<the concrete change + values>","payload":{...}}]}`,
    `  {"status":"needs_input","questions":[{"id":"q1","q":"<ONE plain, actionable question naming the choice + specific values — no check names>"}]}`,
    `  {"status":"human_needed","diagnosis":"<ONE-LINE plain instruction for an out-of-system case>"}`,
    `  {"status":"code_gap","diagnosis":"<the recurring gap + what to do for THIS sub now>","spec":{"slug":"<stable gap-class slug>","title":"...","intent":"<one paragraph>","problem":"<concrete, grounded in the failing check + the live state>","target":"src/lib/<the file/fn to fix>"}}`,
  ].join("\n");
}

// Resume prompt after the owner answered the needs_input question: re-diagnose WITH the answer and
// propose the concrete gated fix. We resume the same Max session (the brief + the question are already
// in context); the brief is re-attached so a lost session still has everything it needs.
function migrationFixAnswerPrompt(audit: Record<string, unknown>, brief: string, answers: unknown): string {
  return [
    `Use the migration-fix skill (cwd is the repo root). You previously paused this FAILED migration on a human-judgment question; the OWNER has now ANSWERED. Use the answer to resolve the judgment call and propose the concrete typed fix — same payload shapes, same final JSON protocol as before.`,
    `OWNER ANSWERS: ${JSON.stringify(answers)}`,
    ``,
    brief,
    ``,
    `With the owner's answer resolving the decision, propose the concrete gated fix (price_reconcile / variant_backfill / appstle_cancel) so the engine re-verifies. Show your arithmetic in the preview. If the answer still leaves it genuinely under-specified, ask ONE more plain follow-up (needs_input); if it's out-of-system, surface human_needed with a one-line plain instruction.`,
    ``,
    `Final message = ONLY one JSON object:`,
    `  {"status":"propose","diagnosis":"<plain-text + the numbers>","actions":[{"fix_kind":"price_reconcile|variant_backfill|appstle_cancel","summary":"<one line>","preview":"<concrete change + values>","payload":{...}}]}`,
    `  {"status":"needs_input","questions":[{"id":"q1","q":"<ONE plain follow-up question>"}]}`,
    `  {"status":"human_needed","diagnosis":"<ONE-LINE plain instruction>"}`,
  ].join("\n");
}

// Map the box's proposed raw actions → typed migration_fix PendingActions (drop anything malformed).
function normalizeMigrationFixActions(raw: unknown, jobId: string): PendingAction[] {
  const arr = Array.isArray(raw) ? raw : [];
  const KINDS = ["price_reconcile", "variant_backfill", "appstle_cancel"];
  const out: PendingAction[] = [];
  arr.forEach((r, i) => {
    const o = (r || {}) as Record<string, unknown>;
    const fix_kind = String(o.fix_kind || "");
    if (!KINDS.includes(fix_kind)) return;
    if (!o.payload || typeof o.payload !== "object") return;
    out.push({
      id: `mf${jobId.slice(0, 6)}${i}`,
      type: "migration_fix",
      fix_kind: fix_kind as PendingAction["fix_kind"],
      summary: String(o.summary || `${fix_kind} fix`),
      preview: typeof o.preview === "string" ? o.preview : undefined,
      payload: o.payload,
      status: "pending",
    });
  });
  return out;
}

// Phase 2 — code-gap escalation. A failure rooted in a recurring CODE/DATA gap (a CLASS of missing
// catalog rows, a pricing-inference edge case the one inference fn can't cover) isn't a one-off billing
// repair — it needs a PERMANENT fix. The box proposes a fix SPEC; the worker commits it to
// docs/brain/specs/ on main (same as box-escalation-triage routes analyzer fixes), surfaced on the
// Roadmap board to commission a build. The migration itself still fails-closed to a human with the
// diagnosis (the spec fixes the CLASS, not this one sub's renewal). Idempotent: a STABLE gap-class slug
// means recurring failures converge on one spec instead of spawning a duplicate per sub.
interface GapSpec { slug: string; title: string; intent: string; problem: string; target?: string }

function migrationGapSpecMarkdown(spec: GapSpec, auditId: string, subId: string): string {
  return [
    `# ${spec.title} ⏳`,
    ``,
    `**Owner:** [[../functions/retention]] · **Parent:** Retention mandate "Subscription continuity & billing integrity" · **Derived-from-migration:** \`${auditId}\``,
    ``,
    spec.intent.trim(),
    ``,
    `## Problem (from failed migration \`${auditId}\`, sub \`${subId}\`)`,
    spec.problem.trim(),
    spec.target ? `\n**Likely target:** \`${spec.target}\`` : ``,
    ``,
    `## Phases`,
    `- ⏳ **P1 — close the gap** — scope from the problem above; land the code/data fix + its brain page; gate on \`npx tsc --noEmit\`.`,
    ``,
    `## Verification`,
    `- Re-run \`verifyMigration\` on a migration that hit this gap → expect it to auto-heal/pass without a hand fix, and confirm the class of failure no longer recurs.`,
    ``,
    `> Authored by the box migration-fix routine from failed migration \`${auditId}\`. Commission the build from the Roadmap board (owner = retention).`,
    ``,
  ].join("\n");
}

// Commit the gap-fix spec to main. Idempotent: if a spec with this (stable, gap-class) slug already
// exists, leave it for the in-flight fix rather than clobbering. Returns a one-line result for log_tail.
async function authorMigrationGapSpec(raw: unknown, auditId: string, subId: string): Promise<string> {
  const s = (raw || {}) as Record<string, unknown>;
  const rawSlug = String(s.slug || "");
  const title = String(s.title || "");
  if (!rawSlug || !title) return "code-gap: no valid fix spec proposed (left diagnosis only)";
  const slug = rawSlug.replace(/[^a-z0-9-]/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 60);
  if (!slug) return "code-gap: spec slug empty after sanitize";
  const path = `docs/brain/specs/${slug}.md`;
  try {
    const existing = await gh("GET", `/repos/${REPO}/contents/${path}?ref=main`);
    if (existing.ok) return `gap spec already tracked: ${path} (commission on Roadmap)`;
    const spec: GapSpec = {
      slug,
      title,
      intent: String(s.intent || "Close the code/data gap behind this recurring migration failure."),
      problem: String(s.problem || "(see the migration-fix diagnosis above)"),
      target: typeof s.target === "string" ? s.target : undefined,
    };
    const put = await putFileMain(
      path,
      migrationGapSpecMarkdown(spec, auditId, subId),
      `spec: ${slug} (from failed migration ${auditId} via migration-fix code-gap escalation)`,
    );
    return put.ok ? `gap spec authored: ${path} (owner=retention) — commission on Roadmap` : `gap spec commit failed (${put.status})`;
  } catch (e) {
    return `gap spec commit failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function runMigrationFixJob(job: Job) {
  const tag = `[migration-fix:${job.id.slice(0, 8)}]`;
  let params: { audit_id?: string; subscription_id?: string } = {};
  try {
    params = job.instructions ? JSON.parse(job.instructions) : {};
  } catch {
    /* not JSON — fall back to spec_slug as the audit id */
  }
  const auditId = params.audit_id || job.spec_slug;
  if (!auditId) {
    await update(job.id, { status: "failed", error: "migration-fix job missing audit_id" });
    return;
  }

  // Two resume modes (checked before a fresh diagnosis):
  //  • approval resume — the owner approved/declined the proposed plan → execute approved actions + re-verify.
  //  • answer resume — the owner answered a needs_input judgment question → re-diagnose WITH the answer and
  //    propose the concrete fix (no decision on any action yet, but answers are present).
  const isApprovalResume = (job.pending_actions || []).some((a) => a.status === "approved" || a.status === "declined");
  const isAnswerResume = !isApprovalResume && (job.answers || []).length > 0;
  console.log(`${tag} ${isApprovalResume ? "executing approved fix + re-verifying" : isAnswerResume ? "re-diagnosing with owner answer" : "diagnosing"} audit ${auditId.slice(0, 8)}`);

  const { data: audit } = await db.from("migration_audits").select("*").eq("id", auditId).maybeSingle();
  if (!audit) {
    await update(job.id, { status: "completed", log_tail: "audit row gone — nothing to fix" });
    return;
  }

  try {
    if (isApprovalResume) {
      // ── Execute the owner-approved typed fixes via the deterministic executor, then re-verify. ──
      const { applyMigrationFix } = await import("../src/lib/migration-fix");
      const actions = (job.pending_actions || []).map((a) => ({ ...a }));
      const results: string[] = [];
      for (const act of actions) {
        if (act.type !== "migration_fix") continue;
        if (act.status === "declined") {
          act.result = "declined by owner";
          results.push(`${act.summary} → declined`);
          continue;
        }
        if (act.status !== "approved") continue;
        try {
          const r = await applyMigrationFix(db, audit as Record<string, unknown>, { fix_kind: act.fix_kind!, payload: act.payload });
          act.status = r.ok ? "done" : "failed";
          act.result = r.detail;
          results.push(`${act.summary} → ${act.status}: ${r.detail}`);
        } catch (e) {
          act.status = "failed";
          act.result = e instanceof Error ? e.message : String(e);
          results.push(`${act.summary} → failed: ${act.result}`);
        }
      }
      await update(job.id, { pending_actions: actions });
      const applied = results.join("; ") || "no approved actions";
      console.log(`${tag} applied: ${applied}`);

      // Re-verify — idempotent + re-verify-gated: only a re-pass clears the audit. The verifyMigration
      // failure hook won't re-enqueue (audit is already `failed` → transition guard + active-job dedupe).
      let verifyStatus = "failed";
      try {
        const { verifyMigration } = await import("../src/lib/migration-audit");
        const v = await verifyMigration(auditId);
        verifyStatus = v.status;
      } catch (e) {
        verifyStatus = "failed";
        console.error(`${tag} re-verify threw:`, e instanceof Error ? e.message : e);
      }

      if (verifyStatus === "passed") {
        await update(job.id, { status: "completed", error: null, log_tail: `re-verified PASSED ✅ — ${applied}`.slice(-2000) });
        console.log(`${tag} ✓ re-verified PASSED → audit clears`);
      } else {
        await update(job.id, {
          status: "completed",
          error: `applied fixes but audit still ${verifyStatus}`,
          log_tail: `Re-verify ${verifyStatus} after fix. ${applied}`.slice(-2000),
        });
        console.log(`${tag} re-verify ${verifyStatus} — stays on /dashboard/migrations with diagnosis`);
      }
      return;
    }

    // ── Fresh diagnosis OR answer-resume: diagnose read-only on Max → propose / needs_input / human-needed. ──
    if (audit.status === "passed") {
      await update(job.id, { status: "completed", log_tail: "audit already passed — nothing to fix" });
      return;
    }
    const brief = await loadMigrationFixBrief(audit as Record<string, unknown>);
    const prompt = isAnswerResume
      ? migrationFixAnswerPrompt(audit as Record<string, unknown>, brief, job.answers || [])
      : migrationFixPrompt(audit as Record<string, unknown>, brief);
    // On an answer-resume, resume the same Max session (the prior question + brief are in context).
    const { session, resultText, isError, raw } = await runMigrationFixClaude(prompt, isAnswerResume ? job.claude_session_id : null, REPO_DIR);
    if (session) await update(job.id, { claude_session_id: session });
    const parsed = extractJson<Record<string, unknown>>(resultText);
    console.log(`${tag} claude finished — status: ${parsed?.status ?? "(none)"} isError=${isError}`);

    if (parsed?.status === "propose") {
      const proposed = normalizeMigrationFixActions(parsed.actions, job.id);
      const diagnosis = String(parsed.diagnosis || "");
      if (!proposed.length) {
        // Proposed but nothing valid landed → surface for a human rather than silently doing nothing.
        await update(job.id, { status: "completed", error: `proposed no valid fix actions`, log_tail: diagnosis.slice(-2000) || "no valid fix actions" });
        return;
      }
      await update(job.id, { status: "needs_approval", pending_actions: proposed, log_tail: diagnosis.slice(-2000) || "(fix proposed)" });
      console.log(`${tag} proposed ${proposed.length} fix(es) → awaiting approval`);
      return;
    }
    if (parsed?.status === "needs_input") {
      // Human-JUDGMENT case: pause with the plain question; the owner answers inline on /dashboard/migrations
      // (POST /api/roadmap/answer → queued_resume) and we resume via the answer path above.
      const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
      const diagnosis = String(parsed.diagnosis || "");
      await update(job.id, { status: "needs_input", questions, log_tail: diagnosis.slice(-2000) || "(awaiting owner answer)" });
      console.log(`${tag} needs_input — asked ${questions.length} plain question(s), awaiting owner answer`);
      return;
    }
    if (parsed?.status === "human_needed") {
      const diagnosis = String(parsed.diagnosis || "needs a human");
      await update(job.id, { status: "completed", error: `human-needed`, log_tail: diagnosis.slice(-2000) });
      console.log(`${tag} human-needed — stays failed with diagnosis`);
      return;
    }
    if (parsed?.status === "code_gap") {
      // Recurring code/data gap → author a permanent fix spec (committed to main, surfaced on Roadmap),
      // and fail-closed to a human with the diagnosis. The spec fixes the CLASS; this sub still needs a
      // hand for now, so the row stays `failed` with the diagnosis.
      const diagnosis = String(parsed.diagnosis || "code/data gap — needs a permanent fix");
      const subId = params.subscription_id || String(audit.subscription_id || "");
      const specResult = await authorMigrationGapSpec(parsed.spec, auditId, subId);
      await update(job.id, { status: "completed", error: `code-gap`, log_tail: `${diagnosis}\n\n${specResult}`.slice(-2000) });
      console.log(`${tag} code-gap — ${specResult}; stays failed with diagnosis`);
      return;
    }
    if (isError && !parsed) {
      await update(job.id, { status: "failed", error: "migration-fix run errored", log_tail: raw.slice(-2000) });
      return;
    }
    // No recognizable status — surface rather than assume fixed.
    await update(job.id, { status: "needs_attention", error: "migration-fix ended without propose/human_needed", log_tail: raw.slice(-2000) });
  } catch (e) {
    await update(job.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    console.error(`${tag} failed:`, e instanceof Error ? e.message : e);
  }
}

// ── Developer Message Center (developer-message-center) ──────────────────────
// A kind='dev-ask' job is ONE turn of a founder-facing, read-only "ask the box anything" thread. Like
// ticket-improve it runs a TOP-LEVEL `claude -p` on Max (ANTHROPIC_API_KEY unset → $0 marginal) and KEEPS
// the DB/crypto secrets — but it ALSO leans on WebSearch (the analyst/planner use case). It runs in a
// per-thread git worktree recreated fresh on origin/main each turn so brain/code reads are current. The
// box is REPORT-BACK, never a builder: reads (SELECT/join/analysis via throwaway uncommitted scripts/_*.ts)
// are silent; every proposed DB write / migration / spec handoff stops at a pending_actions approval card
// the owner must click. Only deterministic worker code (mode:'approve_action') executes an approved card.
async function runDevAskClaude(prompt: string, sessionId: string | null, cwd: string) {
  // KEEP the full env (DB/crypto creds for read-only probes + the throwaway query scripts) — only strip
  // the API key so ALL LLM is Max-billed (never the Anthropic API). WebSearch stays on (analyst/planner).
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const base = sessionId ? ["--resume", sessionId] : [];
  const args = [...base, "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json"];
  const r = await shAsync("claude", args, { cwd, env, timeout: DEV_ASK_TIMEOUT_MS });
  let session = sessionId;
  let resultText = "";
  let isError = r.code !== 0;
  try {
    const obj = JSON.parse((r.out || "").trim());
    session = obj.session_id || session;
    resultText = typeof obj.result === "string" ? obj.result : JSON.stringify(obj);
    isError = isError || obj.is_error === true;
  } catch {
    resultText = (r.out || "") + (r.err || "");
  }
  return { session, resultText, isError, raw: (r.out || "") + (r.err || "") };
}

interface DevThreadRow {
  id: string;
  messages: { role: "user" | "assistant"; content: string }[];
  box_session_id: string | null;
  pending_actions: PendingAction[];
}
async function loadDevThread(threadId: string): Promise<DevThreadRow | null> {
  const { data } = await db
    .from("dev_message_threads")
    .select("id, messages, box_session_id, pending_actions")
    .eq("id", threadId)
    .maybeSingle();
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const msgs = Array.isArray(row.messages) ? (row.messages as { role: "user" | "assistant"; content: string }[]) : [];
  const actions = Array.isArray(row.pending_actions) ? (row.pending_actions as PendingAction[]) : [];
  return { id: row.id as string, messages: msgs, box_session_id: (row.box_session_id as string | null) ?? null, pending_actions: actions };
}

// The model's final JSON for a turn. A pure investigation/analytics answer carries just {reply}. When the
// answer needs a DB write (db_mutation) or it spots a gap worth a spec (spec), it ALSO returns a typed
// pending_actions card — it NEVER executes the write/migration/handoff itself.
function normalizeDevActions(raw: unknown, ts: string): PendingAction[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingAction[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i] as Record<string, unknown>;
    if (!a || typeof a !== "object") continue;
    const t = a.type;
    if (t === "db_mutation") {
      const cmd = typeof a.cmd === "string" ? a.cmd : "";
      if (!cmd) continue; // a write with no command to run is not executable — drop it
      out.push({
        id: `da${ts}${i}`,
        type: "run_prod_script",
        summary: String(a.summary || "Proposed database write"),
        cmd,
        preview: typeof a.preview === "string" ? a.preview : undefined,
        status: "pending",
      });
    } else if (t === "spec") {
      const slug = typeof a.slug === "string" ? a.slug.replace(/[^a-z0-9-]/gi, "") : "";
      const content = typeof a.content === "string" ? a.content : "";
      if (!slug || !content) continue; // a spec handoff needs both a slug and the file body
      out.push({
        id: `da${ts}${i}`,
        type: "spec",
        summary: String(a.summary || `Spec handoff: ${slug}`),
        preview: content.slice(0, 2000),
        status: "pending",
        spec: {
          slug,
          title: String(a.title || slug),
          owner: String(a.owner || ""),
          parent: String(a.parent || ""),
          intent: content, // carry the full markdown body on the proposal so approval is deterministic
        },
        // stash the Send & build choice on the action's payload (read back at approval time).
        payload: { queueBuild: a.queueBuild === true },
      });
    }
  }
  return out;
}

const DEV_ASK_OUTPUT = [
  `Final message = ONLY one JSON object, nothing else:`,
  `{"status":"replied","reply":"<your plain-text answer to the founder — grounded in what you actually read/queried>"}`,
  `  — for a pure investigation / analytics / planning answer (you already ran any read-only query in-session via a throwaway scripts/_*.ts; reads are silent, never asked).`,
  `{"status":"replied","reply":"<answer>","pending_actions":[{"type":"db_mutation","summary":"<what & why>","cmd":"<a SELF-CONTAINED shell command the worker will run on approval — e.g. write a scripts/_apply.ts via heredoc that bootstraps createAdminClient and runs the write, then 'npx tsx scripts/_apply.ts'>","preview":"<the exact statement/rows it changes>"}]}`,
  `  — when the answer REQUIRES an INSERT/UPDATE/DELETE. NEVER run the write yourself; stop and propose it.`,
  `{"status":"replied","reply":"<answer>","pending_actions":[{"type":"spec","summary":"<the gap>","slug":"<kebab-slug>","title":"<Title>","owner":"[[../functions/{fn}]]","parent":"<a function mandate or a goal milestone>","content":"<the FULL docs/brain/specs/{slug}.md markdown, in the house spec format>","queueBuild":false}]}`,
  `  — when you spot a code/capability gap worth a spec. The worker commits the spec to main on approval (and queues a build if queueBuild).`,
  `Schema changes (new table/column/migration) ride the spec→build handoff, NOT a db_mutation. Never run DDL.`,
].join("\n");

function devAskFraming(): string {
  return [
    `You are the ShopCX Developer Message Center — a founder-facing, READ-ONLY "ask the box anything" analyst + planner for Dylan. You have the whole brain (docs/brain/), the full repo (src/), READ access to the production database, and WebSearch. You are a REPORT-BACK system, NOT a builder: you never write product/committed code and never silently mutate anything.`,
    `House rule first: Read docs/brain/ before grepping src/ (start at docs/brain/README.md). Read docs/brain/recipes/dev-message-center-db.md for the DB-query convention before any analytics question.`,
    `DB reads are FREE and SILENT — to answer an analytics/state question, write a THROWAWAY scripts/_*.ts in this worktree that bootstraps createAdminClient (per scripts/_bootstrap.ts / the script-conventions skill), runs the SELECT/join/aggregation, prints the result, then run it with 'npx tsx'. These scripts are scratch: NEVER commit them, never edit docs/brain/ or src/. SELECT-only discipline — never write/UPDATE/DELETE from a query script.`,
    `"Does {feature} work right now?" = a grounded read-only investigation: Read the code + brain + probe recent Inngest runs / error rows read-only; report what you found. No mutation.`,
    `If answering REQUIRES a DB write, a migration, or you find a gap worth a spec — STOP and emit a pending_actions card (below). The owner approves; the worker executes. You never execute a mutation or commit a spec yourself.`,
    DEV_ASK_OUTPUT,
  ].join("\n\n");
}

function renderDevTranscript(messages: DevThreadRow["messages"]): string {
  return messages.map((m) => `${m.role === "user" ? "[Founder]" : "[You]"}: ${m.content}`).join("\n\n");
}

async function runDeveloperMessageJob(job: Job) {
  const tag = `[dev-ask:${job.id.slice(0, 8)}]`;
  let params: { thread_id?: string; mode?: string } = {};
  try {
    params = job.instructions ? JSON.parse(job.instructions) : {};
  } catch {
    /* not JSON — fall back to a plain turn keyed by spec_slug */
  }
  const mode = (params.mode as "turn" | "approve_action") || "turn";
  const threadId = params.thread_id || job.spec_slug;
  if (!threadId) {
    await update(job.id, { status: "failed", error: "dev-ask job missing thread_id" });
    return;
  }

  const failTurn = async (reason: string, logTail?: string) => {
    await db.from("dev_message_threads").update({ turn_status: "error", last_error: reason.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", threadId);
    await update(job.id, { status: "failed", error: reason, log_tail: logTail ?? null });
  };

  const thread = await loadDevThread(threadId);
  if (!thread) {
    await failTurn("dev-ask thread not found");
    return;
  }
  const sessionId = thread.box_session_id;
  const isResume = !!sessionId;
  console.log(`${tag} ${mode} ${isResume ? "(resume)" : "(fresh)"} thread=${threadId}`);

  // Per-thread worktree recreated on origin/main each turn so brain/code reads are current. Tear down after.
  const key = threadId.replace(/[^a-zA-Z0-9_-]/g, "");
  const wt = join(BUILDS_DIR, `dev-ask-${key}`);
  sh("git", ["fetch", "origin", "main"]);
  sh("git", ["worktree", "remove", "--force", wt]);
  const branch = `claude/dev-ask-${key}`;
  const add = sh("git", ["worktree", "add", "-B", branch, wt, "origin/main"]);
  if (add.code !== 0) {
    await failTurn(`worktree add failed: ${add.err.slice(0, 200)}`);
    return;
  }
  sh("ln", ["-sfn", join(REPO_DIR, "node_modules"), join(wt, "node_modules")]);

  try {
    // ── mode:'approve_action' — the owner approved/declined cards; the WORKER executes them. ──
    if (mode === "approve_action") {
      const actions = (thread.pending_actions || []).map((a) => ({ ...a }));
      const notes: string[] = [];
      for (const a of actions) {
        if (a.status === "declined") { a.result = a.result || "declined by owner"; continue; }
        if (a.status !== "approved") continue;
        try {
          if (a.type === "spec" && a.spec) {
            const slug = a.spec.slug;
            const filePath = `docs/brain/specs/${slug}.md`;
            const content = String(a.spec.intent || ""); // the full markdown body parked on the proposal
            if (!content) { a.status = "failed"; a.result = "no spec content"; notes.push(`${a.summary} → failed (no content)`); continue; }
            const put = await putFileMain(filePath, content, `spec: create ${slug} (developer message center)`);
            if (!put.ok) { a.status = "failed"; a.result = `commit failed ${put.status}`; notes.push(`${a.summary} → commit failed`); continue; }
            let queued = false;
            const wantBuild = !!(a.payload && (a.payload as { queueBuild?: boolean }).queueBuild);
            if (wantBuild) {
              const { error } = await db.from("agent_jobs").insert({
                workspace_id: job.workspace_id,
                spec_slug: slug,
                kind: "build",
                status: "queued",
                instructions: "Created via developer message center",
                created_by: job.created_by,
              });
              queued = !error;
            }
            a.status = "done";
            a.result = `committed specs/${slug}.md${queued ? " + queued build" : ""}`;
            notes.push(`Spec ${slug} → committed${queued ? " + build queued" : ""}`);
          } else if (a.cmd) {
            // db_mutation (type 'run_prod_script'): the worker runs the captured self-contained command
            // in the fresh worktree, holding prod creds. The model is NOT in the loop here.
            const r = await shAsync("bash", ["-lc", a.cmd], { timeout: 10 * 60 * 1000, cwd: wt });
            a.status = r.code === 0 ? "done" : "failed";
            a.result = (r.out + r.err).slice(-500);
            notes.push(`${a.summary} → ${a.status}`);
          } else {
            a.status = "failed";
            a.result = "no command to run";
            notes.push(`${a.summary} → failed (no command)`);
          }
        } catch (e) {
          a.status = "failed";
          a.result = e instanceof Error ? e.message : String(e);
          notes.push(`${a.summary} → failed: ${a.result}`);
        }
      }
      const fresh = await loadDevThread(threadId);
      const summary = notes.length ? notes.join("; ") : "No approved actions to execute.";
      const messages = [...(fresh?.messages ?? thread.messages), { role: "assistant" as const, content: `Done: ${summary}` }];
      await db.from("dev_message_threads").update({
        messages,
        pending_actions: actions,
        turn_status: "idle",
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", threadId);
      await update(job.id, { status: "completed", log_tail: `approve_action — ${summary}`.slice(-2000) });
      console.log(`${tag} ✓ executed approved actions: ${summary}`);
      return;
    }

    // ── mode:'turn' — run the box session (read-only investigation/analytics/planning). ──
    const latest = [...thread.messages].reverse().find((m) => m.role === "user")?.content || "";
    const prompt = isResume
      ? `${latest}\n\n${DEV_ASK_OUTPUT}`
      : [devAskFraming(), ``, `Conversation so far:`, renderDevTranscript(thread.messages), ``, `Respond to the latest [Founder] message.`].join("\n");

    const { session, resultText, isError, raw } = await runDevAskClaude(prompt, sessionId, wt);
    const logTail = raw.slice(-2000);
    const newSession = session || sessionId;
    const parsed = parseStatus(resultText) as Record<string, unknown> | null;
    console.log(`${tag} claude finished — status: ${(parsed?.status as string) ?? "(none)"} isError=${isError}`);

    const reply = typeof parsed?.reply === "string" ? (parsed.reply as string) : "";
    if (!reply) {
      await failTurn(isError ? "dev-ask run errored" : "box turn returned no reply", logTail);
      return;
    }
    const ts = Date.now().toString(36);
    const newActions = normalizeDevActions(parsed?.pending_actions, ts);
    const fresh = await loadDevThread(threadId);
    const messages = [...(fresh?.messages ?? thread.messages), { role: "assistant" as const, content: reply }];
    await db.from("dev_message_threads").update({
      messages,
      box_session_id: newSession,
      turn_status: "idle",
      last_error: null,
      pending_actions: newActions, // replace: the latest turn's cards supersede any stale pending ones
      updated_at: new Date().toISOString(),
    }).eq("id", threadId);
    await update(job.id, { status: "completed", log_tail: logTail });
    console.log(`${tag} ✓ reply appended${newActions.length ? ` (+${newActions.length} pending action[s])` : ""}`);
  } finally {
    sh("git", ["worktree", "remove", "--force", wt]);
  }
}

async function runJob(job: Job) {
  if (job.kind === "plan") return runPlanJob(job);
  if (job.kind === "fold") return runFoldJob(job);
  if (job.kind === "product-seed") return runProductSeedJob(job);
  if (job.kind === "spec-chat") return runSpecChatJob(job);
  if (job.kind === "ticket-improve") return runTicketImproveJob(job);
  if (job.kind === "triage-escalations") return runEscalationTriageJob(job);
  if (job.kind === "spec-test") return runSpecTestJob(job);
  if (job.kind === "migration-fix") return runMigrationFixJob(job);
  if (job.kind === "dev-ask") return runDeveloperMessageJob(job);
  const slug = job.spec_slug;
  const isResume = !!job.claude_session_id;
  const tag = `[${slug}]`;
  const wt = join(BUILDS_DIR, job.id); // isolated worktree — parallel builds never collide
  console.log(`${tag} ${isResume ? "resuming" : "building"} (job ${job.id}) in ${wt}`);

  // Set up the worktree (its own dir + branch).
  sh("git", ["fetch", "origin"]);
  let branch = job.spec_branch;
  sh("git", ["worktree", "remove", "--force", wt]); // clear any leftover from a crashed run
  if (!isResume) {
    branch = `claude/${slug}-${Date.now().toString(36)}`;
    const add = sh("git", ["worktree", "add", "-B", branch, wt, "origin/main"]);
    if (add.code !== 0) throw new Error(`worktree add failed: ${add.err.slice(0, 300)}`);
    await update(job.id, { spec_branch: branch });
  } else {
    let add = sh("git", ["worktree", "add", "-B", branch!, wt, `origin/${branch}`]);
    if (add.code !== 0) add = sh("git", ["worktree", "add", "-B", branch!, wt, "origin/main"]); // branch not pushed → base on main
    if (add.code !== 0) throw new Error(`worktree add (resume) failed: ${add.err.slice(0, 300)}`);
  }
  // node_modules is gitignored (absent in a fresh worktree) → symlink the main clone's so tsc/builds work.
  // Force (-sfn) so a leftover/broken link from a prior run is always replaced.
  sh("ln", ["-sfn", join(REPO_DIR, "node_modules"), join(wt, "node_modules")]);

  try {
    // Approval-resume: run the owner-approved gated actions FIRST (in the worktree), then resume.
    let executedSummary = "";
    if (isResume && (job.pending_actions || []).some((a) => a.status === "approved")) {
      const { actions, summary } = await executeApprovedActions(job, wt);
      job.pending_actions = actions; // keep in-memory state in sync — the dedup safety net below reads it
      await update(job.id, { pending_actions: actions });
      executedSummary = summary;
      console.log(`${tag} executed approved actions: ${summary}`);
    }

    const resumeBits: string[] = [];
    if ((job.answers || []).length) resumeBits.push(`Answers to your questions: ${JSON.stringify(job.answers)}`);
    if (executedSummary) resumeBits.push(`Gated actions executed: ${executedSummary}`);
    // Phase 2: explicitly remind the resumed build which gated actions are already settled so it does
    // not re-request them (the #1 cause of a needs_approval loop).
    const settledActions = (job.pending_actions || []).filter(
      (a) => a.status === "done" && a.cmd && (a.type === "apply_migration" || a.type === "run_prod_script"),
    );
    if (settledActions.length) {
      resumeBits.push(`Already-applied gated actions — treat as SETTLED, do NOT re-request them: ${settledActions.map((a) => a.cmd).join("; ")}`);
    }

    const prompt = isResume
      ? `${resumeBits.join(". ") || "Resuming."}. Continue implementing docs/brain/specs/${slug}.md and finish. Same rules and the same final JSON output protocol as before.`
      : [
          `Use the build-spec skill to implement the spec at docs/brain/specs/${slug}.md (cwd is the repo root).`,
          ...(job.instructions ? [`SCOPE for THIS build — do exactly this and nothing more: ${job.instructions}`] : []),
          `Worker protocol (overrides the skill's git step): the harness owns version control — do NOT run git/push or open a PR. Author migrations/scripts as code (write-migration skill). You have NO prod credentials: to apply a migration or run a prod-mutating script, request approval instead of doing it. Run \`npx tsc --noEmit\` and fix errors you introduce. If you hit a product decision the spec doesn't cover, do NOT guess.`,
          `Final message = ONLY one JSON object: {"status":"completed","summary":"…"} | {"status":"needs_input","questions":[{"id","q"}]} | {"status":"needs_approval","actions":[{"type":"apply_migration|run_prod_script","summary":"what & why","cmd":"exact command, e.g. npx tsx scripts/apply-X-migration.ts"}]}. If you make NO file edits (nothing to build / already implemented), still return {"status":"completed","summary":"…","no_changes_reason":"why nothing changed"} — never claim done with no changes and no reason.`,
        ].join("\n");

    const { session, resultText, isError, raw } = await runClaude(prompt, job.claude_session_id, wt);
    const logTail = raw.slice(-2000);
    if (session) await update(job.id, { claude_session_id: session });

    const parsed = parseStatus(resultText);
    console.log(`${tag} claude finished — parsed status: ${parsed?.status ?? "(none)"} isError=${isError}`);

    if (parsed?.status === "needs_input") {
      if (sh("git", ["status", "--porcelain"], { cwd: wt }).out.trim()) {
        sh("git", ["add", "-A"], { cwd: wt });
        sh("git", ["commit", "-m", `wip: ${slug} (needs input)`], { cwd: wt });
        sh("git", ["push", "-u", "origin", branch!], { cwd: wt });
      }
      const pr = await ensurePr(branch!, slug, true);
      await update(job.id, { status: "needs_input", questions: parsed.questions ?? [], log_tail: logTail, pr_url: pr?.url ?? null, pr_number: pr?.number ?? null });
      return;
    }

    if (parsed?.status === "needs_approval") {
      const incoming: Array<Record<string, unknown>> = Array.isArray((parsed as Record<string, unknown>).actions)
        ? ((parsed as Record<string, unknown>).actions as Array<Record<string, unknown>>)
        : [];

      // Worker safety net (build-lifecycle-hardening Phase 2): a resumed build sometimes re-requests an
      // action it already had executed → a needs_approval loop the owner had to clear by hand. Auto-settle
      // any incoming action whose cmd matches one already `done` on the job, instead of re-pausing.
      const priorDone = new Map<string, PendingAction>();
      for (const a of job.pending_actions || []) if (a.status === "done" && a.cmd) priorDone.set(a.cmd, a);

      const pending: PendingAction[] = [];
      let autoSettled = 0;
      let loopGuardTripped = false;
      incoming.forEach((a, i) => {
        const cmd = typeof a.cmd === "string" ? a.cmd : undefined;
        const type = a.type === "merge_pr" || a.type === "run_prod_script" ? (a.type as PendingAction["type"]) : "apply_migration";
        const prior = cmd ? priorDone.get(cmd) : undefined;
        if (prior) {
          prior.autoSettled = (prior.autoSettled ?? 0) + 1;
          if (prior.autoSettled > AUTO_SETTLE_MAX) loopGuardTripped = true;
          autoSettled++;
          console.log(`${tag} auto-settled re-requested action (already done): ${cmd}`);
          return;
        }
        pending.push({
          id: `a${Date.now().toString(36)}${i}`,
          type,
          summary: String(a.summary || cmd || "gated action"),
          cmd,
          preview: typeof a.preview === "string" ? a.preview : cmd,
          status: "pending",
        });
      });

      // Carry the prior (settled) actions forward so the dedup set persists across resume rounds.
      const carried = [...(job.pending_actions || []), ...pending];
      const commitWip = (msg: string) => {
        if (sh("git", ["status", "--porcelain"], { cwd: wt }).out.trim()) {
          sh("git", ["add", "-A"], { cwd: wt });
          sh("git", ["commit", "-m", msg], { cwd: wt });
          sh("git", ["push", "-u", "origin", branch!], { cwd: wt });
        }
      };

      // Every requested action was already applied → don't re-pause the owner; auto-resume so the build finishes.
      if (!pending.length && autoSettled) {
        if (loopGuardTripped) {
          // The build keeps re-requesting an already-applied action despite being told it's settled —
          // stop the bounce loop and surface for a human rather than auto-resuming forever.
          commitWip(`wip: ${slug} (auto-settle loop guard)`);
          const pr = await ensurePr(branch!, slug, true);
          await update(job.id, { status: "needs_attention", pending_actions: carried, error: "build re-requested already-applied action(s) repeatedly", log_tail: logTail, pr_url: pr?.url ?? null, pr_number: pr?.number ?? null });
          console.error(`${tag} auto-settle loop guard tripped → needs_attention`);
          return;
        }
        commitWip(`wip: ${slug} (auto-resume; actions already applied)`);
        await update(job.id, { status: "queued_resume", pending_actions: carried, log_tail: logTail });
        console.log(`${tag} all ${autoSettled} requested action(s) already applied → auto-resuming`);
        return;
      }

      // Genuinely-new gated action(s) remain → pause for the owner as before.
      commitWip(`wip: ${slug} (needs approval)`);
      const pr = await ensurePr(branch!, slug, true);
      await update(job.id, { status: "needs_approval", pending_actions: carried, log_tail: logTail, pr_url: pr?.url ?? null, pr_number: pr?.number ?? null });
      return;
    }

    if (isError && !parsed) {
      await update(job.id, { status: "failed", error: "claude run errored", log_tail: logTail });
      return;
    }

    // completed path: gate on tsc (in the worktree)
    const tsc = await shAsync("npx", ["tsc", "--noEmit"], { timeout: 10 * 60 * 1000, cwd: wt });
    if (tsc.code !== 0) {
      await update(job.id, { status: "failed", error: "tsc failed", log_tail: (tsc.out + tsc.err).slice(-2000) });
      return;
    }

    const dirty = sh("git", ["status", "--porcelain"], { cwd: wt }).out.trim();
    if (!dirty) {
      // No NEW changes — typically because the build committed everything during a needs_approval/needs_input
      // pause and the resume only had the worker apply a migration. A draft PR already exists from that pause,
      // so we must STILL ensure it's ready-for-review + linked, or the job completes stuck as a draft (PR#80).
      const pr = await ensurePr(branch!, slug, false);
      if (pr) {
        const ready = await markReady(pr.number);
        if (!ready) {
          const check = await gh("GET", `/repos/${REPO}/pulls/${pr.number}`);
          if ((check.json as { draft?: boolean })?.draft === true) {
            console.error(`${tag} PR#${pr.number} still draft after markReady (no-change path) — final retry`);
            await markReady(pr.number);
          }
        }
        await update(job.id, { status: "completed", pr_url: pr.url, pr_number: pr.number, log_tail: "no new changes; un-drafted existing PR" });
      } else {
        // No PR AND no changes → the build made zero edits and there's nothing to merge. Don't let it
        // masquerade as `completed` with no PR (3 such builds slipped through silently): surface
        // needs_attention carrying the agent's reason so the card shows a Retry. (fix-report-issue-dropped Phase 3)
        const noChangeReason =
          (typeof parsed?.no_changes_reason === "string" && parsed.no_changes_reason.trim()) ||
          (typeof parsed?.summary === "string" && parsed.summary.trim()) ||
          "build finished with no file changes — nothing committed and no PR";
        await update(job.id, { status: "needs_attention", error: noChangeReason, log_tail: logTail });
        console.error(`${tag} no changes + no PR → needs_attention: ${noChangeReason}`);
      }
      return;
    }
    sh("git", ["add", "-A"], { cwd: wt });
    const commit = sh("git", ["commit", "-m", `build: ${slug}\n\n${parsed?.summary ?? ""}`], { cwd: wt });
    if (commit.code !== 0) {
      await update(job.id, { status: "failed", error: "git commit failed", log_tail: (commit.out + commit.err).slice(-2000) });
      return;
    }
    const push = sh("git", ["push", "-u", "origin", branch!], { cwd: wt });
    if (push.code !== 0) {
      await update(job.id, { status: "failed", error: "git push failed", log_tail: push.err.slice(-2000) });
      return;
    }
    const pr = await ensurePr(branch!, slug, false);
    if (!pr) {
      await update(job.id, { status: "needs_attention", error: "branch pushed but PR creation failed", log_tail: logTail });
      return;
    }
    // Un-draft if this PR was opened during an earlier needs_input/needs_approval pause.
    const ready = await markReady(pr.number);
    if (!ready) {
      // Belt-and-suspenders: confirm the draft state directly and retry once more before completing —
      // a non-draft, mergeable PR is the whole point (PR#75/#76 had to be un-drafted by hand).
      const check = await gh("GET", `/repos/${REPO}/pulls/${pr.number}`);
      if ((check.json as { draft?: boolean })?.draft === true) {
        console.error(`${tag} PR#${pr.number} still draft after markReady — final retry before completing`);
        await markReady(pr.number);
      }
    }
    await update(job.id, { status: "completed", pr_url: pr.url, pr_number: pr.number, log_tail: logTail });
    console.log(`${tag} ✓ completed → ${pr.url}`);
  } finally {
    // Always tear down the worktree — the branch is pushed, so a resume recreates one.
    sh("git", ["worktree", "remove", "--force", wt]);
  }
}

async function main() {
  if (!GH_TOKEN) throw new Error("GITHUB_TOKEN not set");
  db = await admin();

  // Crash-loop guard (worker-self-update Phase 2): if a freshly self-updated worker keeps dying on
  // startup, stop flapping — leave a needs_attention heartbeat once and exit non-zero so systemd's
  // StartLimit can give up instead of churning on a broken commit.
  if (recordStartupAttempt()) {
    const crash = readCrashFile();
    if (!crash.alerted) {
      await writeHeartbeat(0, "needs_attention", `worker crash-loop on ${RUNNING_SHA || "unknown"} (${crash.count} startup failures) — manual redeploy needed`);
      writeCrashFile({ ...crash, alerted: true });
    }
    console.error(`[crash-loop] worker has failed startup ${crash.count}× on ${RUNNING_SHA} — giving up; left needs_attention heartbeat`);
    process.exit(1);
  }

  ensureGitIdentity();
  mkdirSync(BUILDS_DIR, { recursive: true });
  sh("git", ["worktree", "prune"]); // clear stale worktrees from a previous run
  console.log(`builder-worker up — repo ${REPO} @ ${RUNNING_SHA || "?"}, up to ${MAX_CONCURRENT} build lanes + ${MAX_FOLD} fold + ${MAX_SEED} seed + ${MAX_SPEC_CHAT} spec-chat + ${MAX_TICKET_IMPROVE} ticket-improve + ${MAX_TRIAGE} triage + ${MAX_SPEC_TEST} spec-test + ${MAX_MIGRATION_FIX} migration-fix + ${MAX_DEV_ASK} dev-ask lane, polling every ${POLL_MS}ms`);

  // Per-kind concurrency (fold-build-batching Phase 2): build+plan share the MAX_CONCURRENT pool;
  // kind='fold' gets its own concurrency-1 lane so a fold never races a feature build on the index files.
  // Per-lane detail (build-box-status-view): the value carries what the lane is building + when it
  // started, so each heartbeat tick can publish the full lane picture (kind/spec_slug/since).
  interface LaneInfo { kind: Job["kind"]; spec_slug: string; since: string }
  const active = new Map<string, LaneInfo>();
  const countFold = () => [...active.values()].filter((v) => v.kind === "fold").length;
  const countSeed = () => [...active.values()].filter((v) => v.kind === "product-seed").length;
  const countSpecChat = () => [...active.values()].filter((v) => v.kind === "spec-chat").length;
  const countImprove = () => [...active.values()].filter((v) => v.kind === "ticket-improve").length;
  const countTriage = () => [...active.values()].filter((v) => v.kind === "triage-escalations").length;
  const countSpecTest = () => [...active.values()].filter((v) => v.kind === "spec-test").length;
  const countMigrationFix = () => [...active.values()].filter((v) => v.kind === "migration-fix").length;
  const countDevAsk = () => [...active.values()].filter((v) => v.kind === "dev-ask").length;
  const countOther = () => [...active.values()].filter((v) => v.kind !== "fold" && v.kind !== "product-seed" && v.kind !== "spec-chat" && v.kind !== "ticket-improve" && v.kind !== "triage-escalations" && v.kind !== "spec-test" && v.kind !== "migration-fix" && v.kind !== "dev-ask").length;
  const launch = (job: Job) => {
    active.set(job.id, { kind: job.kind, spec_slug: job.spec_slug, since: new Date().toISOString() });
    const startedAt = Date.now();
    let errored = false;
    runJob(job)
      .catch(async (e) => {
        errored = true;
        console.error(`[${job.spec_slug}] failed:`, e);
        await update(job.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
      })
      .finally(async () => {
        active.delete(job.id);
        // Control Tower: end-of-run agent-kind heartbeat. ok = ran without a thrown error AND
        // the job didn't land on a terminal failure status.
        let ok = !errored;
        let status: string | undefined;
        try {
          const { data } = await db.from("agent_jobs").select("status").eq("id", job.id).maybeSingle();
          status = (data?.status as string | undefined) ?? undefined;
          if (status === "failed" || status === "needs_attention") ok = false;
        } catch { /* status read best-effort */ }
        await writeLoopHeartbeat(`agent:${job.kind}`, ok, { status: status ?? (errored ? "failed" : "completed") }, Date.now() - startedAt);
      });
  };

  let steady = false; // flips true after the first clean poll tick → clears the crash-loop counter
  for (;;) {
    try {
      // Fill the fold lane first (cheap, doc-only, keeps the fleet mergeable).
      while (countFold() < MAX_FOLD) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["fold"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed fold ${job.id.slice(0, 8)} → ${countFold() + 1}/${MAX_FOLD} fold lane`);
        launch(job);
      }
      // Fill the product-seed lane (Max `claude -p` seed-product skill; box-product-seeding).
      while (countSeed() < MAX_SEED) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["product-seed"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed product-seed ${job.id.slice(0, 8)} → ${countSeed() + 1}/${MAX_SEED} seed lane`);
        launch(job);
      }
      // Fill the spec-chat lane (box-spec-chat; concurrency-1 interactive authoring-chat turns on Max).
      while (countSpecChat() < MAX_SPEC_CHAT) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["spec-chat"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed spec-chat ${job.id.slice(0, 8)} → ${countSpecChat() + 1}/${MAX_SPEC_CHAT} spec-chat lane`);
        launch(job);
      }
      // Fill the ticket-improve lane (box-ticket-improve): interactive Max turns, concurrency-1.
      while (countImprove() < MAX_TICKET_IMPROVE) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["ticket-improve"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed ticket-improve ${job.id.slice(0, 8)} → ${countImprove() + 1}/${MAX_TICKET_IMPROVE} improve lane`);
        launch(job);
      }
      // Fill the escalation-triage lane (box-escalation-triage): hourly solver→skeptic→quorum sweep, concurrency-1.
      while (countTriage() < MAX_TRIAGE) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["triage-escalations"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed triage-escalations ${job.id.slice(0, 8)} → ${countTriage() + 1}/${MAX_TRIAGE} triage lane`);
        launch(job);
      }
      // Fill the spec-test lane (spec-test-agent): non-destructive QA pass over a shipped spec, concurrency-1.
      while (countSpecTest() < MAX_SPEC_TEST) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["spec-test"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed spec-test ${job.id.slice(0, 8)} → ${countSpecTest() + 1}/${MAX_SPEC_TEST} spec-test lane`);
        launch(job);
      }
      // Fill the migration-fix lane (migration-fix-agent): event-fired gated billing repair, concurrency-1.
      while (countMigrationFix() < MAX_MIGRATION_FIX) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["migration-fix"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed migration-fix ${job.id.slice(0, 8)} → ${countMigrationFix() + 1}/${MAX_MIGRATION_FIX} migration-fix lane`);
        launch(job);
      }
      // Fill the dev-ask lane (developer-message-center): interactive Max turns w/ read-only DB + WebSearch, concurrency-1.
      while (countDevAsk() < MAX_DEV_ASK) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["dev-ask"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed dev-ask ${job.id.slice(0, 8)} → ${countDevAsk() + 1}/${MAX_DEV_ASK} dev-ask lane`);
        launch(job);
      }
      // Fill the build/plan pool.
      while (countOther() < MAX_CONCURRENT) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["build", "plan"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed ${job.spec_slug} → ${countOther() + 1}/${MAX_CONCURRENT} build lanes`);
        launch(job);
      }
      // First clean tick → this sha is healthy; zero the crash-loop counter.
      if (!steady) { clearStartupCrashCounter(); steady = true; }

      // Heartbeat for the dashboard, then self-update if fully idle (never mid-build).
      const lanes: LaneRow[] = [...active.entries()].map(([job_id, v]) => ({ kind: v.kind, job_id, spec_slug: v.spec_slug, since: v.since }));
      await writeHeartbeat(active.size, "healthy", undefined, lanes);
      await maybeSelfUpdate(active.size); // exits the process (→ systemd restart) when behind origin/main
    } catch (e) {
      console.error("poll error:", e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
