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
  type: "apply_migration" | "run_prod_script" | "merge_pr" | "spec";
  summary: string;
  cmd?: string;
  preview?: string;
  status: "pending" | "approved" | "declined" | "done" | "failed";
  result?: string;
  spec?: ProposedSpec;
  autoSettled?: number; // worker safety net: times a resumed build re-requested this already-`done` cmd
}
interface Job {
  id: string;
  workspace_id: string;
  spec_slug: string; // for kind='plan' this is the GOAL slug; for kind='fold' a 'fold-batch' sentinel
  spec_branch: string | null;
  kind: "build" | "plan" | "fold" | "product-seed" | "ticket-improve" | "triage-escalations";
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

function parseStatus(text: string): { status: string; questions?: unknown[]; summary?: string } | null {
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
  console.log(
    `${tag} ${isResume ? "resuming" : isMediaRefresh ? "media-refreshing" : isContentRefresh ? "content-refreshing" : "seeding"} product ${productId} on Max (job ${job.id})`,
  );

  const prompt = isResume
    ? `Resuming. Continue the product-seed for product_id=${productId} (workspace_id=${job.workspace_id}) and finish. Same rules and the same final JSON output protocol as before.`
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
  const { selectEscalatedForTriage, loadTriageBrief, materializeTriageOutcome, recordTriageRun } = await import(
    "../src/lib/agent-todos/triage"
  );

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

async function runJob(job: Job) {
  if (job.kind === "plan") return runPlanJob(job);
  if (job.kind === "fold") return runFoldJob(job);
  if (job.kind === "product-seed") return runProductSeedJob(job);
  if (job.kind === "ticket-improve") return runTicketImproveJob(job);
  if (job.kind === "triage-escalations") return runEscalationTriageJob(job);
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
          `Final message = ONLY one JSON object: {"status":"completed","summary":"…"} | {"status":"needs_input","questions":[{"id","q"}]} | {"status":"needs_approval","actions":[{"type":"apply_migration|run_prod_script","summary":"what & why","cmd":"exact command, e.g. npx tsx scripts/apply-X-migration.ts"}]}.`,
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
        await update(job.id, { status: "completed", log_tail: "no file changes; nothing to commit" });
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
  console.log(`builder-worker up — repo ${REPO} @ ${RUNNING_SHA || "?"}, up to ${MAX_CONCURRENT} build lanes + ${MAX_FOLD} fold lane, polling every ${POLL_MS}ms`);

  // Per-kind concurrency (fold-build-batching Phase 2): build+plan share the MAX_CONCURRENT pool;
  // kind='fold' gets its own concurrency-1 lane so a fold never races a feature build on the index files.
  // Per-lane detail (build-box-status-view): the value carries what the lane is building + when it
  // started, so each heartbeat tick can publish the full lane picture (kind/spec_slug/since).
  interface LaneInfo { kind: Job["kind"]; spec_slug: string; since: string }
  const active = new Map<string, LaneInfo>();
  const countFold = () => [...active.values()].filter((v) => v.kind === "fold").length;
  const countSeed = () => [...active.values()].filter((v) => v.kind === "product-seed").length;
  const countImprove = () => [...active.values()].filter((v) => v.kind === "ticket-improve").length;
  const countTriage = () => [...active.values()].filter((v) => v.kind === "triage-escalations").length;
  const countOther = () => [...active.values()].filter((v) => v.kind !== "fold" && v.kind !== "product-seed" && v.kind !== "ticket-improve" && v.kind !== "triage-escalations").length;
  const launch = (job: Job) => {
    active.set(job.id, { kind: job.kind, spec_slug: job.spec_slug, since: new Date().toISOString() });
    runJob(job)
      .catch(async (e) => {
        console.error(`[${job.spec_slug}] failed:`, e);
        await update(job.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => active.delete(job.id));
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
