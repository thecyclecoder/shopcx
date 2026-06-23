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
import { resolve, join, basename } from "path";
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
// Build liveness (build-all-phases-chain Part B): a multi-phase build can legitimately work for
// 40+ min, so don't guillotine on wall-clock. Instead kill only if the build subprocess goes
// SILENT for BUILD_IDLE_TIMEOUT_MS (hung), with BUILD_HARD_CAP_MS as a generous backstop against a
// process that emits noise forever. Requires the streaming runner (stream-json, see runClaude) so
// that active work keeps producing output and "building" is distinguishable from "stuck".
const BUILD_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // no output for 10 min ⇒ hung ⇒ kill + fail
const BUILD_HARD_CAP_MS = 60 * 60 * 1000;     // absolute ceiling, even while still emitting output
// Product-seed runs the full Engine to completion on Max (per-ingredient web
// research + ~2000-review analysis + content + imagery) — give it a long ceiling.
const SEED_TIMEOUT_MS = 90 * 60 * 1000;
// A ticket-improve turn is one Max `claude -p` investigation/proposal (read brain/src + web + the
// read-only DB tools). Minutes, not the 90-min seed ceiling. See box-ticket-improve.
const IMPROVE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CONCURRENT = 8; // build/plan pool — real ceiling is Max rate limits, not the box (CCX33 8-core/30GB sits at ~14% load / 6% RAM with the old 5; bumped 5→8, watch box logs for Max 529/overloaded before pushing further)
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
const MAX_SPEC_TEST = 3; // read-only QC runs — bumped 1→3 so a backlog re-sweep (e.g. human→machine reclassification) drains in parallel instead of one-at-a-time. Browser checks (Playwright/chromium ~400MB) fit easily in 30GB.
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
// PR-resolve jobs (dirty-pr-resolver-agent) run in their OWN concurrency-1 lane: event-fired by the
// GitHub webhook the moment a push to main dirties an open claude/* build PR. A top-level `claude -p`
// on Max (git available, prod secrets stripped — NO prod creds) merges origin/main into the PR branch
// + resolves the (usually additive) conflicts in a throwaway worktree; the worker then runs the tsc
// GATE + pushes (never a non-compiling merge), or — on a heavy parallel-rewrite divergence / a merge
// that can't compile — rebuilds the spec on main (close + re-queue) or surfaces it to the owner.
// Serialized: a resolve mutates a shared branch, and one box session per PR is right (event-driven).
const MAX_PR_RESOLVE = Number(process.env.AGENT_TODO_MAX_PR_RESOLVE || 1);
// One resolve pass: git merge + LLM conflict resolution + ≤2 tsc attempts. Build-sized ceiling so a
// big merge + a couple tsc runs never gets cut short.
const PR_RESOLVE_TIMEOUT_MS = 20 * 60 * 1000;
// Repair jobs (repair-agent) run in their OWN concurrency-limited lane: event-fired the moment the
// Control Tower records a NEW problem (a new error_events signature via recordError, a newly-opened
// loop_alert via the monitor). A top-level `claude -p` on Max (web search on, no API key, KEEPS the
// read-only DB/crypto secrets) INVESTIGATES the signature + the implicated route/cron/fn read-only,
// classifies it, and either authors a fix spec to main + surfaces it for owner Build (default), or
// auto-queues the build for an allow-listed mechanical class, or no-op-resolves a transient, or
// surfaces needs-human. It NEVER edits product code / opens a PR / applies a migration. A few lanes
// so N errors at once drain a few at a time without a pileup; re-claimable (a restart re-runs it).
const MAX_STOREFRONT_OPTIMIZER = Number(process.env.AGENT_TODO_MAX_STOREFRONT_OPTIMIZER || 1);
// A storefront-optimizer campaign cycle: read-only diagnose on Max → propose a typed campaign / a
// missing-capability spec. Generous — it may generate a Nano-Banana hero on the worker side post-approval.
const STOREFRONT_OPTIMIZER_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_REPAIR = Number(process.env.AGENT_TODO_MAX_REPAIR || 2);
// One repair pass: read-only investigation (the signature + sample + the implicated code) + a
// verdict. Minutes — same ballpark as a migration-fix / ticket-improve turn, not the seed ceiling.
const REPAIR_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_REGRESSION = Number(process.env.AGENT_TODO_MAX_REGRESSION || 1);
// One regression review: read-only investigation (the regressed spec + its failing checks + what
// shipped) + a verdict, and (for a real regression) authoring the fix spec doc. Minutes, like repair.
const REGRESSION_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_DB_HEALTH = Number(process.env.AGENT_TODO_MAX_DB_HEALTH || 1);
const MAX_COVERAGE_REGISTER = Number(process.env.AGENT_TODO_MAX_COVERAGE_REGISTER || 1);
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

// Control Tower migration-drift check (control-tower-migration-drift-check P1): a periodic box job
// that diffs every migration-created table against the live public schema. Runs here (not as an
// Inngest cron) because the deployed runtime can't read the .sql files. Gated to ~30 min + an
// in-flight guard so it never overlaps or blocks the 5s poll loop.
const MIGRATION_DRIFT_INTERVAL_MS = 30 * 60 * 1000;
let lastMigrationDriftCheck = 0; // 0 ⇒ run on the first poll so there's a beat right away.
let migrationDriftInFlight = false;

// DB Health Agent (db-health-agent P1): two box-side passes on different cadences. The FREQUENT
// slow-query root-cause pass (~hourly) reads pg_stat_statements + EXPLAINs each top offender; the
// DAILY size sweep snapshots per-table size/stats + flags growth/index/bloat. Both run here (not as
// Inngest crons) because EXPLAIN + pg_stat_* need the pooler the deployed runtime can't use — same
// rationale as migration-drift. In-flight-guarded + gated so they never overlap or stall the poll.
const DB_HEALTH_SLOWQ_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DB_HEALTH_SIZE_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
let lastDbHealthSlowQ = 0; // 0 ⇒ run on first poll so there's a beat right away.
let lastDbHealthSize = 0;
let dbHealthSlowQInFlight = false;
let dbHealthSizeInFlight = false;
const DB_HEALTH_MAX_PROPOSALS_PER_PASS = 5; // don't flood: surface at most the top-N findings/pass.
const DB_HEALTH_TREND_WINDOW_DAYS = 21; // Phase 2: trailing size-history window for the trend projection.

// `blocked_on_usage` (box-multi-account-failover Phase 1): parked when EVERY Max account is at its usage
// wall. Non-terminal — requeueBlockedOnUsage flips it back to queued/queued_resume once an account resets.
type JobStatus = "queued" | "claimed" | "building" | "needs_input" | "needs_approval" | "queued_resume" | "blocked_on_usage" | "completed" | "failed" | "needs_attention";
// A planner-proposed spec branch, carried on a type:'spec' action (goal-decomposition-engine).
interface ProposedSpec {
  slug: string;
  title: string;
  owner: string;
  parent: string;
  milestone?: string;
  intent: string;
  gap?: string;
  // Prerequisite slugs (goal-decomposition-encodes-blockers): sibling proposed specs or already-existing
  // specs this branch depends on. Acyclic. Written as the spec's `**Blocked-by:**` header on resume
  // authoring — but filtered to approved blockers only (a declined sibling is dropped, not left dangling).
  blocked_by?: string[];
}
interface PendingAction {
  id: string;
  type: "apply_migration" | "run_prod_script" | "merge_pr" | "spec" | "migration_fix" | "repair_build" | "regression_build" | "storefront_campaign" | "storefront_build" | "db_health_build" | "coverage_register";
  summary: string;
  cmd?: string;
  preview?: string;
  status: "pending" | "approved" | "declined" | "done" | "failed" | "reject_regen";
  result?: string;
  spec?: ProposedSpec;
  autoSettled?: number; // worker safety net: times a resumed build re-requested this already-`done` cmd
  // set when type==='migration_fix' (migration-fix-agent): the typed billing repair the worker runs via
  // src/lib/migration-fix.ts `applyMigrationFix` on approval.
  fix_kind?: "price_reconcile" | "variant_backfill" | "appstle_cancel";
  payload?: unknown;
  // set when type==='repair_build' (repair-agent) OR type==='storefront_build' (storefront-optimizer)
  // OR type==='db_health_build' (db-health-agent): the fix/feature spec slug the agent authored to main
  // (db_health: pre-authored at detection, committed on Build) + surfaced for one-tap owner Build. The
  // build is queued on approval, NOT auto.
  spec_slug?: string;
  // set when type==='db_health_build' OR type==='coverage_register': the human-readable title of the proposed fix spec.
  spec_title?: string;
  // set when type==='db_health_build' (db-health-spec-body-robust): the diagnostic carried ON the action,
  // un-clobberable by an approval that overwrites the free-text `instructions` (approve mutates the action
  // by STATUS only). `spec_body` is the pre-rendered fix spec; `finding` is the structured DbHealthFinding
  // the body re-renders from if `spec_body` is ever empty. The owner-Build resume reads the body from HERE
  // first, falling back to `instructions.spec_body` for proposals enqueued before this field existed.
  spec_body?: string;
  finding?: import("../src/lib/control-tower/db-health").DbHealthFinding;
  // set when type==='coverage_register' (coverage-register-agent): the owner's decision on a surfaced
  // unregistered-loop proposal — 'register' lands the MONITORED_LOOPS entry, 'exempt' adds the
  // INTENTIONALLY_UNMONITORED_CRONS exemption. The box materializes the matching fix spec + queues its build.
  decision?: "register" | "exempt";
  // set when type==='storefront_campaign' (storefront-optimizer): the typed OptimizerProposal the box
  // session emitted; the worker stands up the M1 experiment from it on approval (or immediately when the
  // gate is auto_run). Carries hypothesis + lever + reversible variant patch.
  campaign_plan?: unknown;
  // ── optimizer-hero-preview-gate (preview/reject-with-notes loop) ──
  // For a kind='hero' campaign the approval is two-stage: 'concept' (the owner approves the idea →
  // the worker generates a candidate hero, sets stage='preview') then 'preview' (the owner sees the
  // ACTUAL image → Approve goes live, or Reject-with-notes regenerates). A content lever has no image
  // to preview, so it skips the gate (stage stays undefined → materialize on the first approve).
  stage?: "concept" | "preview";
  // The candidate hero awaiting image-approval (NOT live until the owner approves it).
  preview_image_url?: string;
  // The rejected attempts kept on the campaign (the gen learns within the loop). Newest last.
  preview_attempts?: { url: string; notes?: string; at: string }[];
  // The owner's free-text notes set by a Reject-with-notes action; consumed (then cleared) on regen.
  reject_notes?: string;
}
interface Job {
  id: string;
  workspace_id: string;
  spec_slug: string; // for kind='plan' this is the GOAL slug; for kind='fold' a 'fold-batch' sentinel
  spec_branch: string | null;
  kind: "build" | "plan" | "fold" | "product-seed" | "ticket-improve" | "spec-chat" | "triage-escalations" | "spec-test" | "migration-fix" | "dev-ask" | "pr-resolve" | "repair" | "regression" | "storefront-optimizer" | "db_health" | "coverage-register";
  status: JobStatus;
  claude_session_id: string | null;
  // The CLAUDE_CONFIG_DIR (Max account) that CREATED claude_session_id. A resume MUST pin to it — a
  // cross-account `claude --resume` always fails "No conversation found" (box-multi-account-failover P1).
  claude_session_config_dir: string | null;
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
function shAsync(cmd: string, args: string[], opts: { timeout?: number; idleTimeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string; err: string; killed?: "idle" | "hardcap" }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd || REPO_DIR, env: opts.env || process.env });
    let out = "";
    let err = "";
    let killed: "idle" | "hardcap" | undefined;
    const cap = 64 * 1024 * 1024;
    // Hard cap (opts.timeout): absolute wall-clock backstop — kills even a process that keeps
    // emitting output forever.
    const hardTimer = opts.timeout ? setTimeout(() => { killed = "hardcap"; child.kill("SIGKILL"); }, opts.timeout) : null;
    // Idle/hang detection (opts.idleTimeout): reset on every chunk of output; if the process goes
    // silent for idleTimeout it's hung → kill. Liveness, not a wall-clock guillotine. Off unless a
    // caller opts in.
    let idleTimer: NodeJS.Timeout | null = null;
    const bumpIdle = () => {
      if (!opts.idleTimeout) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { killed = "idle"; child.kill("SIGKILL"); }, opts.idleTimeout);
    };
    bumpIdle();
    child.stdout?.on("data", (d) => { out += d.toString(); if (out.length > cap) out = out.slice(-cap); bumpIdle(); });
    child.stderr?.on("data", (d) => { err += d.toString(); if (err.length > cap) err = err.slice(-cap); bumpIdle(); });
    const cleanup = () => { if (hardTimer) clearTimeout(hardTimer); if (idleTimer) clearTimeout(idleTimer); };
    child.on("close", (code) => { cleanup(); resolve({ code: code ?? -1, out, err, killed }); });
    child.on("error", (e) => { cleanup(); resolve({ code: -1, out, err: err + String(e), killed }); });
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

// ── Multi-account round-robin + usage-cap failover (box-multi-account-failover Phase 1) ──────────
// The box runs `claude` on Max (no API key). A single Max account hits a 5-hour usage wall; with ONE
// account a burst of builds caps it and EVERYTHING fails until the reset (the 2026-06-22 "12 builds
// failed at once"). So the box keeps a POOL of CLAUDE_CONFIG_DIRs — each an isolated, once-logged-in
// Max account — and:
//  • round-robins NEW sessions across healthy accounts (load splits ~50/50 → ~2× sustained throughput,
//    each account hits its wall ~2× slower) — the main, proactive win;
//  • on a usage-cap failure (distinct from a 529/overloaded transient, which the existing retry owns)
//    PULLS that account from rotation until its estimated reset, concentrating work on the healthy one(s);
//  • PINS every resume to the account that CREATED its session — a cross-account `claude --resume` is a
//    guaranteed "No conversation found" (learned + proven 2026-06-22); a build whose owning account is
//    capped starts FRESH on a healthy account instead (idempotent — it re-reads the spec);
//  • when ALL accounts are capped, parks the job `blocked_on_usage` (auto-resumes at the soonest reset),
//    never a hard fail / manual rebuild.
// State is in-memory: capped-state re-derives from live failures after a restart, and `blocked_on_usage`
// rows persist in the DB (re-queued by requeueBlockedOnUsage once an account frees up). The chosen config
// dir is persisted per-job (claude_session_config_dir) so a later resume knows which account to pin to.
const ACCOUNT_POOL: string[] = (
  process.env.CLAUDE_CONFIG_DIRS || "/home/builder/.claude,/home/builder/.claude-personal"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Max's wall resets ~5h after first use; the CLI doesn't hand us the exact reset, so a capped account
// rejoins rotation after this conservative cooldown (the spec's "reset-time estimate").
const USAGE_CAP_COOLDOWN_MS = 5 * 60 * 60 * 1000;

interface AccountState {
  configDir: string;
  inFlight: number;       // builds currently running on this account — least-loaded wins the round-robin
  lastAssignedAt: number; // tie-break: least-recently-used
  cappedUntil: number;    // 0 = healthy; else epoch-ms until which it's pulled from rotation
  capEventLogged: boolean; // a `cap` event was already recorded for the CURRENT cap window (so recovery logs once)
}
const accounts: AccountState[] = ACCOUNT_POOL.map((d) => ({ configDir: d, inFlight: 0, lastAssignedAt: 0, cappedUntil: 0, capEventLogged: false }));
const accountByDir = new Map(accounts.map((a) => [a.configDir, a]));

// A short, human label for an account ("account 1 · personal") derived from its config dir basename, so
// the box-health surface doesn't leak the full path. `~/.claude` → "account 1 · default"; a "-personal"
// suffix → "personal". Index keeps two same-named dirs distinguishable.
function accountLabel(dir: string, idx: number): string {
  const base = dir.replace(/\/+$/, "").split("/").pop() || dir;
  const suffix = base === ".claude" ? "default" : base.replace(/^\.claude-?/, "") || base;
  return `account ${idx + 1} · ${suffix}`;
}

// Recent cap/failover events (box-multi-account-failover Phase 2) — a small in-memory ring surfaced on the
// heartbeat so the Control Tower / box-health view shows WHY load shifted (a cap, a failover, an
// all-capped park, a reset recovery), not just the current per-account numbers. In-memory: a restart
// re-derives state from live failures, and these are operational breadcrumbs, not a durable audit log.
type AccountEvent = { at: string; type: "cap" | "failover" | "all_capped" | "recovered"; account: string; detail: string };
const accountEvents: AccountEvent[] = [];
const ACCOUNT_EVENTS_MAX = 12;
function recordAccountEvent(type: AccountEvent["type"], dir: string, detail: string) {
  const idx = accounts.findIndex((a) => a.configDir === dir);
  accountEvents.push({ at: new Date().toISOString(), type, account: accountLabel(dir, idx < 0 ? 0 : idx), detail });
  if (accountEvents.length > ACCOUNT_EVENTS_MAX) accountEvents.splice(0, accountEvents.length - ACCOUNT_EVENTS_MAX);
}

// Detect accounts whose cap window has expired and log ONE `recovered` event each (so a reset rejoining
// the rotation is visible, not silent). Called each poll tick. Best-effort, never throws.
function noteAccountRecoveries(now: number) {
  for (const a of accounts) {
    if (a.capEventLogged && a.cappedUntil <= now) {
      a.capEventLogged = false;
      recordAccountEvent("recovered", a.configDir, "usage wall reset — back in rotation");
    }
  }
}

// The per-account snapshot the worker writes onto its heartbeat (box-multi-account-failover Phase 2). Carries
// per-account in-flight load + capped state, the healthy count, the all-capped flag, and the recent event
// ring — everything the box-health view + Control Tower box tile need to show how each Max account is burning.
function accountsSnapshot(now: number) {
  return {
    pool: accounts.map((a, i) => ({
      label: accountLabel(a.configDir, i),
      in_flight: a.inFlight,
      capped: a.cappedUntil > now,
      capped_until: a.cappedUntil > now ? new Date(a.cappedUntil).toISOString() : null,
    })),
    healthy: healthyAccounts(now).length,
    total: accounts.length,
    all_capped: allAccountsCapped(now),
    soonest_reset: allAccountsCapped(now) ? new Date(soonestReset(now)).toISOString() : null,
    events: accountEvents.slice().reverse(), // newest first
  };
}

function healthyAccounts(now: number): AccountState[] {
  return accounts.filter((a) => a.cappedUntil <= now);
}
function allAccountsCapped(now: number): boolean {
  return accounts.length > 0 && healthyAccounts(now).length === 0;
}
function soonestReset(now: number): number {
  const capped = accounts.filter((a) => a.cappedUntil > now);
  return capped.length ? Math.min(...capped.map((a) => a.cappedUntil)) : now;
}
// Least-recently-used / round-robin: among HEALTHY accounts pick the one with the fewest in-flight
// builds, tie-broken by least-recently-assigned. NEW sessions only (never reassigns a pinned resume).
function pickNewSessionAccount(now: number): AccountState | null {
  const healthy = healthyAccounts(now);
  if (!healthy.length) return null;
  healthy.sort((a, b) => a.inFlight - b.inFlight || a.lastAssignedAt - b.lastAssignedAt);
  return healthy[0];
}
function markAccountCapped(dir: string, now: number) {
  const a = accountByDir.get(dir);
  if (!a) return;
  a.cappedUntil = now + USAGE_CAP_COOLDOWN_MS;
  if (!a.capEventLogged) {
    a.capEventLogged = true; // record the `cap` once per window; noteAccountRecoveries logs the matching `recovered`
    recordAccountEvent("cap", dir, `usage wall hit — pulled from rotation until ~${new Date(a.cappedUntil).toISOString()}`);
  }
}
// Distinguish a Max usage-WALL (pull the account from rotation) from a transient 529/overloaded (which
// the existing retry owns — NOT a cap, NOT an account switch). Conservative: a 529/overloaded mention
// short-circuits to "not a cap" so a transient is never mistaken for the wall.
function isUsageCapError(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (/\b529\b|overloaded/.test(t)) return false; // transient — existing retry path
  return /usage limit reached|usage limit|limit reached|limit will reset|out of usage|quota (?:exceeded|reached)|reached your usage limit|5-? ?hour limit/.test(t);
}

// The account decision for a job at dispatch time. `run` → use this config dir (and this session, which
// is null when starting fresh); `blocked` → every account is capped, park `blocked_on_usage`.
type AccountDecision =
  | { kind: "run"; configDir: string; sessionId: string | null; startedFresh: boolean }
  | { kind: "blocked"; resetAt: number };

// Resolve which account a build/plan job runs under. NEW session → round-robin/LRU. RESUME → PIN to the
// session's owning account (stored claude_session_config_dir); if that account is capped, either start
// fresh on a healthy account (canStartFresh — builds are idempotent) or, when the job can't tolerate a
// fresh start (a plan resume authoring approved specs), wait (blocked_on_usage).
function resolveAccountForJob(
  job: Pick<Job, "claude_session_id" | "claude_session_config_dir">,
  isResume: boolean,
  canStartFresh: boolean,
): AccountDecision {
  const now = Date.now();
  if (isResume && job.claude_session_id) {
    const owner = job.claude_session_config_dir ? accountByDir.get(job.claude_session_config_dir) : undefined;
    if (owner && owner.cappedUntil <= now) {
      return { kind: "run", configDir: owner.configDir, sessionId: job.claude_session_id, startedFresh: false }; // healthy owner → PIN
    }
    // Owning account capped (or unknown — a legacy session recorded before pinning). A cross-account
    // `--resume` is a guaranteed "No conversation found", so never try it.
    if (!canStartFresh) {
      // The job can't be restarted from scratch — wait for the owning account (or, if it's gone from the
      // pool, the soonest reset). Parked, auto-resumes.
      const resetAt = owner ? owner.cappedUntil : soonestReset(now);
      return { kind: "blocked", resetAt: resetAt > now ? resetAt : now + USAGE_CAP_COOLDOWN_MS };
    }
    const fresh = pickNewSessionAccount(now);
    if (!fresh) return { kind: "blocked", resetAt: soonestReset(now) };
    return { kind: "run", configDir: fresh.configDir, sessionId: null, startedFresh: true };
  }
  // NEW session — round-robin / LRU across healthy accounts.
  const acct = pickNewSessionAccount(now);
  if (!acct) return { kind: "blocked", resetAt: soonestReset(now) };
  return { kind: "run", configDir: acct.configDir, sessionId: null, startedFresh: false };
}

// Re-queue jobs parked `blocked_on_usage` once ANY account is healthy again. A job that had a session
// goes back to `queued_resume` (resolveAccountForJob re-pins / starts fresh on claim); a fresh job →
// `queued`. Best-effort — a sweep failure must never break the poll loop.
async function requeueBlockedOnUsage() {
  const now = Date.now();
  if (allAccountsCapped(now)) return; // nothing healthy yet — leave them parked until a reset
  const { data, error } = await db
    .from("agent_jobs")
    .select("id, claude_session_id")
    .eq("status", "blocked_on_usage")
    .limit(100);
  if (error || !data?.length) return;
  for (const r of data as { id: string; claude_session_id: string | null }[]) {
    await update(r.id, { status: r.claude_session_id ? "queued_resume" : "queued", error: null });
  }
  console.log(`[multi-account] re-queued ${data.length} blocked_on_usage job(s) — a healthy account is available`);
}

// Shared usage-cap handler for the build/plan pool (box-multi-account-failover Phase 1): pull the
// account from rotation, then either re-dispatch on a healthy account (back to queued_resume if a session
// exists so the branch/PR is reused, else queued) or park blocked_on_usage when ALL accounts are capped.
// Returns true once it has set the job's status — the caller should then return.
async function handlePoolUsageCap(jobId: string, tag: string, configDir: string, hadSession: boolean, logTail: string): Promise<boolean> {
  markAccountCapped(configDir, Date.now());
  if (allAccountsCapped(Date.now())) {
    recordAccountEvent("all_capped", configDir, "all Max accounts capped — job parked blocked_on_usage, auto-resumes at reset");
    await update(jobId, { status: "blocked_on_usage", error: "Max usage wall hit on all accounts — auto-resumes at reset", log_tail: logTail });
    console.warn(`${tag} usage cap on ${configDir} → all accounts capped → blocked_on_usage`);
  } else {
    recordAccountEvent("failover", configDir, `failing over — re-dispatching ${hadSession ? "resume" : "build"} on a healthy account`);
    await update(jobId, { status: hadSession ? "queued_resume" : "queued", error: null, log_tail: logTail });
    console.warn(`${tag} usage cap on ${configDir} → re-dispatching on a healthy account`);
  }
  return true;
}

async function runClaude(prompt: string, sessionId: string | null, cwd: string, configDir?: string) {
  // Sandbox: stay on Max (no API key) AND drop prod-write secrets. Keep NEXT_PUBLIC_* (non-secret).
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "ANTHROPIC_API_KEY") continue;
    if (/^NEXT_PUBLIC_/.test(k)) { env[k] = v; continue; }
    if (SECRET_RE.test(k)) continue;
    env[k] = v;
  }
  // Multi-account: point the `claude` CLI at the chosen account's isolated credentials/config dir. An
  // ALIAS can't reach a spawned process (no shell), so the worker must set CLAUDE_CONFIG_DIR in the env
  // object itself. Unset → the CLI's default (~/.claude = pool[0]) — back-compat for callers not yet
  // wired into the pool (box-multi-account-failover Phase 1).
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  const base = sessionId ? ["--resume", sessionId] : [];
  // stream-json (not json): the build must emit output continuously while it works so the hang
  // detector can tell "actively building" from "stuck". Plain json buffers the whole run and prints
  // once at the very end — zero liveness signal, so idle detection would kill every long build.
  // --verbose is required by stream-json. The final {type:"result"} event carries the result text.
  const args = [...base, "-p", prompt, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"];
  const r = await shAsync("claude", args, { cwd, env, idleTimeout: BUILD_IDLE_TIMEOUT_MS, timeout: BUILD_HARD_CAP_MS });
  let session = sessionId;
  let resultText = "";
  let isError = r.code !== 0;
  // stream-json output is newline-delimited JSON events; the final {type:"result"} carries the
  // result text + session_id + is_error. Parse line-by-line; the last result event wins.
  let parsedResult = false;
  for (const line of (r.out || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: { type?: string; session_id?: string; result?: unknown; is_error?: boolean };
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (typeof obj.session_id === "string") session = obj.session_id;
    if (obj.type === "result") {
      resultText = typeof obj.result === "string" ? obj.result : JSON.stringify(obj);
      isError = isError || obj.is_error === true;
      parsedResult = true;
    }
  }
  if (!parsedResult) {
    // No result event — killed mid-run (hang/cap) or non-stream output. Surface raw + treat as error.
    resultText = (r.out || "") + (r.err || "");
    isError = true;
  }
  if (r.killed === "idle") {
    isError = true;
    resultText = `[build killed: no output for ${Math.round(BUILD_IDLE_TIMEOUT_MS / 60000)} min — treated as hung]\n` + resultText;
  } else if (r.killed === "hardcap") {
    isError = true;
    resultText = `[build killed: exceeded the ${Math.round(BUILD_HARD_CAP_MS / 60000)} min hard cap]\n` + resultText;
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
  const prBody = body ?? `Automated build of \`docs/brain/specs/${title}\` by the box worker. ${draft ? "**Draft — has open questions.**" : ""}`;
  // Retry `gh pr create` a few times with backoff — most failures are transient (GitHub 5xx / secondary
  // rate-limit), so the manual Create-PR recovery (build-recover-pr-create) is the rare fallback, not the
  // norm. Before each retry adopt an already-open PR for the branch (idempotent: a prior attempt may have
  // actually created one despite a flaky response). Only after the retries are exhausted do we return
  // null → the caller flags `needs_attention` "branch pushed but PR creation failed" (recoverable).
  const backoffs = [1000, 3000, 8000];
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    const created = await gh("POST", `/repos/${REPO}/pulls`, { title, head: branch, base: "main", body: prBody, draft });
    if (created.ok) return { url: created.json.html_url as string, number: created.json.number as number };
    const existing = await gh("GET", `/repos/${REPO}/pulls?head=${owner}:${branch}&state=open`);
    if (existing.ok && Array.isArray(existing.json) && existing.json.length) {
      return { url: existing.json[0].html_url as string, number: existing.json[0].number as number };
    }
    if (attempt < backoffs.length) {
      console.error(
        `[ensurePr] create PR for ${branch} failed (${created.status}: ${JSON.stringify(created.json).slice(0, 160)}) — retry ${attempt + 1}/${backoffs.length} in ${backoffs[attempt]}ms`,
      );
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
    }
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

// Re-runnable / idempotent kinds (worker-orphan-reaper + self-update): a restart loses nothing — they
// just re-claim off the queue. The SAME set the poll loop calls INTERRUPTIBLE (those it won't block a
// self-update on) and the reaper resets to `queued`. Every other kind is a work-PRODUCER (a PR, pushed
// branch, published content, a user's mid-turn) a restart could leave half-done → the reaper fails it.
const RERUNNABLE_KINDS = new Set<Job["kind"]>(["spec-test", "triage-escalations", "migration-fix", "dev-ask", "pr-resolve", "repair", "regression", "storefront-optimizer", "db_health", "coverage-register"]);

// Startup orphan-reaper (worker-orphan-reaper Phase 1): when the previous worker instance died mid-job
// (self-update `git reset --hard` + exit, deploy, or crash) its in-flight rows sit in `building`/`claimed`/
// `queued_resume` forever — the new instance only claims `queued`, so they never complete and the Control
// Tower flags them as stuck (a real, but self-inflicted, alert). On boot, before the poll loop, reap every
// job a PREVIOUS instance owned (`claimed_at < WORKER_STARTED_AT` — the heartbeat cutoff, so nothing the
// current instance is actively running is ever touched): re-runnable kinds → back to `queued` (re-run, no
// work lost); work-producers → `failed` (visible in the failed-builds callout + recoverable via Create PR,
// never blindly re-queued so we never double-push a branch). Idempotent: reaped rows leave `building`, so a
// re-run is a no-op; a clean restart with nothing orphaned logs "0 reaped".
// ── Worktree reaping (worker-orphan-reaper-worktree-prune) ───────────────────
// The box never cleaned git worktrees, which caused two distinct failures: (1) a resume's
// `git worktree add <branch>` blew up with "already used by worktree at …" when the first run's tree
// for that branch still existed, and (2) terminal/merged builds left their worktree (and disk) behind
// to pile up. These helpers (a) enumerate worktrees, (b) force-remove the tree holding a branch so an
// add is idempotent, and (c) sweep stale build worktrees in reapOrphans. All run as the worker's own
// user (correct git ownership) and tolerate a worktree whose dir is already gone.

// A build/plan/pr-resolve/fold worktree is `builds/<job.id>`; job.id is a UUID. spec-chat-*/dev-ask-*
// lanes (non-UUID basenames) are session-stable + torn down each turn — never swept here.
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Jobs whose worktree is sacrosanct — a live or paused build the owner may still resume. Anything else
// (completed/failed/needs_attention, i.e. terminal) or a job that no longer exists ⇒ the tree is cruft.
const ACTIVE_JOB_STATUSES = new Set<JobStatus>(["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume", "blocked_on_usage"]);

// Parse `git worktree list --porcelain` → [{ path, branch }]. branch is the short name (refs/heads/
// stripped) or null when detached. Tolerates odd/empty git output by returning what it parsed.
function listWorktrees(): { path: string; branch: string | null }[] {
  const out = sh("git", ["worktree", "list", "--porcelain"]).out;
  const entries: { path: string; branch: string | null }[] = [];
  let cur: { path: string; branch: string | null } | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length).trim(), branch: null };
      entries.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  return entries;
}

// Force-remove a worktree dir + nuke any lingering directory. `git worktree remove --force` clears the
// admin entry; if the dir survived (or the remove failed because the dir was already gone), the rm -rf
// + a later `git worktree prune` reconcile the admin list. Never throws — best-effort cleanup.
function removeWorktreeDir(path: string) {
  sh("git", ["worktree", "remove", "--force", path]);
  if (existsSync(path)) sh("rm", ["-rf", path]);
}

// Idempotent worktree-add precondition: if ANY worktree already holds <branch> (from a prior run that
// crashed or paused without tearing down), force-remove it so `git worktree add -B <branch>` can't fail
// with "already used by worktree at …". Then prune stale admin entries.
function removeWorktreeForBranch(branch: string) {
  for (const e of listWorktrees()) {
    if (e.branch === branch) removeWorktreeDir(e.path);
  }
  sh("git", ["worktree", "prune"]);
}

// Sweep stale build worktrees: every `builds/<job.id>` worktree whose backing job is terminal — or no
// longer exists, which is also how a merged-and-deleted branch surfaces — is cruft → force-remove it.
// A live or paused job's worktree is NEVER touched (status in ACTIVE_JOB_STATUSES). Best-effort.
async function reapOrphanWorktrees() {
  const entries = listWorktrees().filter((e) => e.path.startsWith(BUILDS_DIR + "/") && JOB_ID_RE.test(basename(e.path)));
  if (entries.length === 0) {
    sh("git", ["worktree", "prune"]); // reconcile admin entries for already-deleted dirs
    console.log("[reaper] 0 build worktrees on disk");
    return;
  }
  const ids = entries.map((e) => basename(e.path));
  const { data, error } = await db.from("agent_jobs").select("id, status").in("id", ids);
  if (error) {
    console.error("[reaper] worktree-job status query failed (skipping worktree sweep):", error.message);
    return;
  }
  const byId = new Map<string, JobStatus>();
  for (const r of (data ?? []) as { id: string; status: JobStatus }[]) byId.set(r.id, r.status);
  let removed = 0;
  let kept = 0;
  for (const e of entries) {
    const status = byId.get(basename(e.path));
    if (status && ACTIVE_JOB_STATUSES.has(status)) { kept++; continue; } // sacrosanct — live/paused build
    removeWorktreeDir(e.path);
    removed++;
    console.log(`[reaper] reaped stale worktree ${e.path} (job ${status ?? "missing"})`);
  }
  sh("git", ["worktree", "prune"]);
  console.log(`[reaper] worktrees: removed ${removed} terminal/orphaned, kept ${kept} active`);
}

async function reapOrphans() {
  // 1) Orphaned in-flight JOBS from a previous instance.
  const { data, error } = await db
    .from("agent_jobs")
    .select("id, kind, spec_slug, status")
    .in("status", ["building", "claimed", "queued_resume"])
    .lt("claimed_at", WORKER_STARTED_AT);
  if (error) {
    console.error("[reaper] orphan job query failed (skipping job reap):", error.message);
  } else {
    const orphans = (data ?? []) as Pick<Job, "id" | "kind" | "spec_slug" | "status">[];
    if (orphans.length === 0) {
      console.log("[reaper] 0 reaped — no orphaned in-flight jobs from a previous instance");
    } else {
      const reset: Record<string, number> = {};
      const failed: Record<string, number> = {};
      for (const job of orphans) {
        if (RERUNNABLE_KINDS.has(job.kind)) {
          await update(job.id, { status: "queued", claimed_at: null });
          reset[job.kind] = (reset[job.kind] ?? 0) + 1;
        } else {
          await update(job.id, { status: "failed", error: "orphaned by worker restart" });
          failed[job.kind] = (failed[job.kind] ?? 0) + 1;
        }
      }
      const fmt = (m: Record<string, number>) => Object.entries(m).map(([k, n]) => `${k}×${n}`).join(", ") || "none";
      console.log(`[reaper] reaped ${orphans.length} orphan(s) from a previous instance — re-queued: ${fmt(reset)}; failed: ${fmt(failed)}`);
    }
  }
  // 2) Orphaned WORKTREES — runs even when 0 orphaned jobs (a crashed teardown leaves a worktree behind
  // with no in-flight job; merged/terminal builds leave their tree on disk). Best-effort, never blocks.
  try {
    await reapOrphanWorktrees();
  } catch (e) {
    console.error("[reaper] worktree sweep failed (continuing):", e instanceof Error ? e.message : String(e));
  }
}

// fold-guard-live-build (Phase 1) — cleanup backstop. Cancel any still-non-terminal build/spec-test job
// whose spec has been ARCHIVED (folded into the brain → moved to docs/brain/archive.d/): it's an orphan
// whose spec page 404s and whose paused/active card is a dead link. The preventive guard (the fold path
// refusing a live spec) makes this rare; this catches a fold that raced a build. Best-effort — a failure
// here must never break worker startup.
async function reapArchivedSpecJobs() {
  try {
    const { cancelJobsForArchivedSpecs } = await import("../src/lib/agent-jobs");
    const { cancelled, slugs } = await cancelJobsForArchivedSpecs();
    if (cancelled > 0) console.log(`[reaper] cancelled ${cancelled} orphaned job(s) for archived spec(s): ${slugs.join(", ")}`);
    else console.log("[reaper] 0 archived-spec orphans — no non-terminal job points at an archived spec");
  } catch (e) {
    console.error("[reaper] archived-spec reap failed (non-fatal):", e instanceof Error ? e.message : String(e));
  }
}

// ── Heartbeat + self-update (worker-self-update) ─────────────────────────────
// Upsert the singleton worker_heartbeats row so the dashboard can show "worker: <sha>, healthy Ns ago"
// (and surface a crash-loop) without SSH. Best-effort: a heartbeat write must never break the poll loop.
const WORKER_STARTED_AT = new Date().toISOString();
// One in-flight lane, surfaced on the heartbeat so the dashboard can show what each lane is building
// right now (build-box-status-view). job_id ties back to agent_jobs; since = when the lane started.
// phase = which phase a chained/per-phase build is on (e.g. "Phase 2"), derived from the job's
// instructions (the phaseScopedInstructions format embeds `"Phase N — <title>"`); null for a
// whole-spec build or a non-build lane (box-lane-show-phase).
interface LaneRow { kind: Job["kind"]; job_id: string; spec_slug: string; since: string; phase?: string | null }

// Derive the phase a build lane is on from its instructions. A per-phase/chained build's
// instructions embed `"Phase N — <title>"` (phaseScopedInstructions); a whole-spec build (or any
// non-build job whose instructions are JSON params) has no single phase → null. Never throws.
function derivePhase(instructions: string | null | undefined): string | null {
  if (!instructions) return null;
  const m = /\bPhase\s+(\d+)\b/i.exec(instructions);
  return m ? `Phase ${m[1]}` : null;
}
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
      lanes, // [{ kind, job_id, spec_slug, since, phase }] for every in-flight lane this tick
      // Per-account Max load + cap/failover events (box-multi-account-failover Phase 2): surfaces how each
      // account's quota is burning + an all-capped state to the box-health view + Control Tower box tile.
      accounts: accountsSnapshot(Date.now()),
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

// Control Tower: one loop_heartbeats row for a BOX-EMITTED cron (kind 'cron', not 'agent-kind') —
// the migration-drift check. Same best-effort discipline: a heartbeat write must never break the loop.
async function writeCronHeartbeat(loopId: string, ok: boolean, produced: unknown, durationMs: number, detail?: string) {
  try {
    await db.from("loop_heartbeats").insert({
      loop_id: loopId,
      kind: "cron",
      ok,
      produced: produced ?? null,
      detail: detail ?? null,
      duration_ms: durationMs,
      ran_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[loop-heartbeat] cron write failed:", e instanceof Error ? e.message : String(e));
  }
}

// Read the live `public` BASE TABLE names off the pooler (raw SQL — information_schema isn't exposed
// through PostgREST). Returns null when the host has no DB password (→ the check reports 'skipped',
// never a false "no drift"). Best-effort connect/teardown.
async function fetchLivePublicTables(): Promise<string[] | null> {
  let connectionString: string;
  try {
    const { poolerConnectionString } = await import("./_bootstrap");
    connectionString = poolerConnectionString();
  } catch {
    return null; // no SUPABASE_DB_PASSWORD / SUPABASE_DB_URL on this host — skip honestly.
  }
  const { Client } = await import("pg");
  const c = new Client({ connectionString });
  await c.connect();
  try {
    const res = await c.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    return (res.rows as Array<{ table_name: string }>).map((r) => r.table_name);
  } finally {
    await c.end();
  }
}

// The periodic migration-drift job: parse supabase/migrations/*.sql → diff the live schema → write
// the result into the migration-drift-check loop's heartbeat. The Control Tower monitor's
// migration-drift output assertion reads produced.missing and flips the tile red on drift; freshness
// keeps a DEAD check visible. NEVER throws (guarded) — a check failure must not break the poll loop.
async function runMigrationDriftJob(): Promise<void> {
  const startedAt = Date.now();
  try {
    const { runMigrationDriftCheck, driftSummary, MIGRATION_DRIFT_LOOP_ID } = await import(
      "../src/lib/control-tower/migration-drift"
    );
    const result = await runMigrationDriftCheck({
      migrationsDir: resolve(REPO_DIR, "supabase/migrations"),
      fetchLiveTables: fetchLivePublicTables,
    });
    const summary = driftSummary(result);
    await writeCronHeartbeat(
      MIGRATION_DRIFT_LOOP_ID,
      result.status !== "skipped", // ok reflects "did the check run"; drift is an output-assertion concern.
      {
        status: result.status,
        missing: result.missing,
        allowlistedMissing: result.allowlistedMissing,
        expectedCount: result.expectedCount,
        liveCount: result.liveCount,
        parsedFiles: result.parsedFiles,
        reason: result.reason,
      },
      Date.now() - startedAt,
      summary,
    );
    if (result.status === "drift") console.warn(`[migration-drift] ${summary}`);
    else console.log(`[migration-drift] ${summary}`);
  } catch (e) {
    console.error("[migration-drift] check failed:", e instanceof Error ? e.message : String(e));
  }
}

// ── DB Health Agent box passes (db-health-agent P1) ───────────────────────────
// Open a short-lived pooler connection (raw pg — pg_stat_* / EXPLAIN aren't reachable via PostgREST).
// Returns null when the host has no DB password (→ the pass reports skipped, never a false "healthy").
async function dbHealthPgClient(): Promise<import("pg").Client | null> {
  let connectionString: string;
  try {
    const { poolerConnectionString } = await import("./_bootstrap");
    connectionString = poolerConnectionString();
  } catch {
    return null; // no SUPABASE_DB_PASSWORD / SUPABASE_DB_URL on this host — skip honestly.
  }
  const { Client } = await import("pg");
  const c = new Client({ connectionString });
  await c.connect();
  return c;
}

// EXPLAIN a safe SELECT and return the plan text, or null if it can't be planned. Plain EXPLAIN does
// NOT execute the query (no ANALYZE) so it's safe on prod; for a normalized parameterized statement
// (pg_stat_statements stores `$1` placeholders) plain EXPLAIN errors, so we retry with GENERIC_PLAN
// (PG16+), which plans a parameterized query with no values. Every attempt is isolated in its own
// try — a failed EXPLAIN must never abort the pass.
async function explainQuery(c: import("pg").Client, query: string): Promise<string | null> {
  const render = (rows: Array<Record<string, unknown>>): string =>
    rows.map((r) => String(r["QUERY PLAN"] ?? Object.values(r)[0] ?? "")).join("\n");
  try {
    const res = await c.query(`EXPLAIN (FORMAT TEXT) ${query}`);
    return render(res.rows as Array<Record<string, unknown>>);
  } catch {
    /* likely parameter placeholders — retry with a generic plan. */
  }
  try {
    const res = await c.query(`EXPLAIN (GENERIC_PLAN, FORMAT TEXT) ${query}`);
    return render(res.rows as Array<Record<string, unknown>>);
  } catch {
    return null; // pre-PG16 or an un-plannable statement — the finding still proposes a rewrite review.
  }
}

// Resolve the fix-spec body for an owner-Build resume, robust to a clobbered `instructions`
// (db-health-spec-body-robust). Resolution order: the un-clobberable action-carried body → the (older)
// instructions body → re-render from the structured `finding` carried on the action. Returns `{error}`
// ONLY when the body is genuinely empty AND there's no finding to reconstruct from — the caller then
// surfaces needs_input instead of ever committing an empty spec.
async function resolveDbHealthSpecBody(
  buildAction: PendingAction,
  instr: { spec_body?: string },
): Promise<{ body: string } | { error: string }> {
  const isNonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
  if (isNonEmpty(buildAction.spec_body)) return { body: buildAction.spec_body };
  if (isNonEmpty(instr.spec_body)) return { body: instr.spec_body };
  // Empty/whitespace body — re-derive deterministically from the structured finding on the action.
  if (buildAction.finding) {
    try {
      const { buildFixSpecMarkdown } = await import("../src/lib/control-tower/db-health");
      const rederived = buildFixSpecMarkdown(buildAction.finding);
      if (isNonEmpty(rederived)) return { body: rederived };
      return { error: "re-rendered spec body from the carried finding was still empty" };
    } catch (e) {
      return { error: `re-derive from carried finding threw: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { error: "spec body empty and no carried finding to re-derive from" };
}

// Author the proposed fix spec to main + queue the build — the owner-gate, run on a db_health Build
// resume. The spec body was pre-authored deterministically at detection time (carried on the job's
// db_health_build action), so there's no LLM step. Mirrors the repair-agent owner-Build path.
async function materializeDbHealthSpec(specSlug: string, specBody: string, signature: string): Promise<boolean> {
  try {
    // Final backstop (db-health-spec-body-robust): NEVER putFileMain an empty/phaseless spec. The caller
    // already resolves + re-derives a non-empty body, so this should be unreachable — but a 0-byte commit
    // is exactly the failure this spec exists to stop, so refuse it here too.
    if (!specBody || !specBody.trim() || !/^##\s+Phase/m.test(specBody)) {
      console.warn(`[db-health] refusing to author empty/phaseless spec ${specSlug} (signature ${signature})`);
      return false;
    }
    const put = await putFileMain(
      `docs/brain/specs/${specSlug}.md`,
      specBody,
      `spec: ${specSlug} (from DB Health Agent signature ${signature})`,
    );
    return put.ok;
  } catch (e) {
    console.warn(`[db-health] spec commit failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// Surface the top-N ranked findings as deduped proposals. Returns how many were newly enqueued.
async function surfaceDbHealthFindings(findings: import("../src/lib/control-tower/db-health").DbHealthFinding[]): Promise<number> {
  const { dedupeFindings, enqueueDbHealthProposal } = await import("../src/lib/control-tower/db-health");
  const ranked = dedupeFindings(findings).slice(0, DB_HEALTH_MAX_PROPOSALS_PER_PASS);
  let enqueued = 0;
  for (const f of ranked) {
    const r = await enqueueDbHealthProposal(db, f);
    if (r.enqueued) enqueued++;
  }
  return enqueued;
}

// The FREQUENT slow-query root-cause pass: top pg_stat_statements offenders → EXPLAIN → classify →
// propose. Writes a kind:'cron' beat (loop_id = DB_HEALTH_SLOWQ_LOOP_ID) carrying the slow-query list
// for the panel. NEVER throws (guarded) — a pass failure must not break the poll loop. Zero DDL.
async function runDbHealthSlowQueryJob(): Promise<void> {
  const startedAt = Date.now();
  const mod = await import("../src/lib/control-tower/db-health");
  let c: import("pg").Client | null = null;
  try {
    c = await dbHealthPgClient();
    if (!c) {
      await writeCronHeartbeat(mod.DB_HEALTH_SLOWQ_LOOP_ID, false, { status: "skipped", reason: "no DB connection on this host" }, Date.now() - startedAt, "db-health slow-query skipped — no pooler");
      return;
    }
    let rows: import("../src/lib/control-tower/db-health").SlowQueryRow[] = [];
    try {
      const res = await c.query(
        `select queryid::text as queryid, query, calls,
                total_exec_time, mean_exec_time, stddev_exec_time, rows
           from pg_stat_statements
          where query is not null
            and query not ilike '%pg_stat_statements%'
            and query not ilike '%db_table_size_history%'
            and query not ilike '%loop_heartbeats%'
          order by total_exec_time desc
          limit 25`,
      );
      rows = (res.rows as Array<Record<string, unknown>>).map((r) => ({
        queryid: String(r.queryid ?? ""),
        query: String(r.query ?? ""),
        calls: Number(r.calls ?? 0),
        total_exec_time: Number(r.total_exec_time ?? 0),
        mean_exec_time: Number(r.mean_exec_time ?? 0),
        stddev_exec_time: Number(r.stddev_exec_time ?? 0),
        rows: Number(r.rows ?? 0),
      }));
    } catch (e) {
      // pg_stat_statements not installed / not granted — honest skip, not a false "healthy".
      await writeCronHeartbeat(mod.DB_HEALTH_SLOWQ_LOOP_ID, false, { status: "skipped", reason: `pg_stat_statements read failed: ${e instanceof Error ? e.message : String(e)}` }, Date.now() - startedAt, "db-health slow-query skipped — no pg_stat_statements");
      return;
    }

    const findings: import("../src/lib/control-tower/db-health").DbHealthFinding[] = [];
    for (const row of rows) {
      // Only EXPLAIN read-only SELECTs (plain EXPLAIN doesn't execute, but never go near a write).
      const plan = mod.isSafeSelect(row.query) ? await explainQuery(c, row.query) : null;
      const finding = mod.analyzeSlowQuery(row, plan);
      if (finding) findings.push(finding);
    }
    const proposed = await surfaceDbHealthFindings(findings);
    const ranked = mod.dedupeFindings(findings);
    const slow_queries = ranked.slice(0, 10).map((f) => ({ queryid: f.signature.split(":").pop() || "", cause: f.cause, table: f.table, impact: f.impact }));
    await writeCronHeartbeat(
      mod.DB_HEALTH_SLOWQ_LOOP_ID,
      true,
      { status: "ok", scanned: rows.length, findings: findings.length, proposed, slow_queries },
      Date.now() - startedAt,
      `db-health slow-query — ${rows.length} scanned, ${mod.summarizeFindings(findings)}, ${proposed} proposed`,
    );
    console.log(`[db-health] slow-query pass — ${rows.length} scanned, ${findings.length} findings, ${proposed} proposed`);
  } catch (e) {
    console.error("[db-health] slow-query pass failed:", e instanceof Error ? e.message : String(e));
  } finally {
    if (c) await c.end().catch(() => {});
  }
}

// The DAILY size sweep: snapshot per-table size+stats into db_table_size_history (so growth rate is
// computable), then flag unbounded growth / missing+unused indexes / bloat and propose the fix. Beats
// under DB_HEALTH_SIZE_LOOP_ID. NEVER throws (guarded). Zero DDL/deletes.
async function runDbHealthSizeJob(): Promise<void> {
  const startedAt = Date.now();
  const mod = await import("../src/lib/control-tower/db-health");
  let c: import("pg").Client | null = null;
  try {
    c = await dbHealthPgClient();
    if (!c) {
      await writeCronHeartbeat(mod.DB_HEALTH_SIZE_LOOP_ID, false, { status: "skipped", reason: "no DB connection on this host" }, Date.now() - startedAt, "db-health size sweep skipped — no pooler");
      return;
    }
    const capturedAt = new Date().toISOString();
    // Per-table size + live stats (pg_class + pg_stat_user_tables).
    const tblRes = await c.query(
      `select c.relname as table_name,
              pg_total_relation_size(c.oid)::bigint as total_bytes,
              pg_table_size(c.oid)::bigint as table_bytes,
              pg_indexes_size(c.oid)::bigint as index_bytes,
              greatest(c.reltuples, 0)::bigint as row_estimate,
              coalesce(s.seq_scan, 0)::bigint as seq_scan,
              coalesce(s.idx_scan, 0)::bigint as idx_scan,
              coalesce(s.n_live_tup, 0)::bigint as n_live_tup,
              coalesce(s.n_dead_tup, 0)::bigint as n_dead_tup,
              s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_stat_user_tables s on s.relid = c.oid
        where n.nspname = 'public' and c.relkind = 'r'
        order by pg_total_relation_size(c.oid) desc`,
    );
    const tables: import("../src/lib/control-tower/db-health").TableSizeRow[] = (tblRes.rows as Array<Record<string, unknown>>).map((r) => ({
      table_name: String(r.table_name ?? ""),
      total_bytes: Number(r.total_bytes ?? 0),
      row_estimate: Number(r.row_estimate ?? 0),
      seq_scan: Number(r.seq_scan ?? 0),
      idx_scan: Number(r.idx_scan ?? 0),
      n_live_tup: Number(r.n_live_tup ?? 0),
      n_dead_tup: Number(r.n_dead_tup ?? 0),
      last_autovacuum: r.last_autovacuum ? new Date(r.last_autovacuum as string).toISOString() : null,
      captured_at: capturedAt,
    }));

    // Snapshot the whole batch (one shared captured_at) so the next sweep can compute a day-delta.
    const snapshotRows = (tblRes.rows as Array<Record<string, unknown>>).map((r) => ({
      captured_at: capturedAt,
      table_name: String(r.table_name ?? ""),
      total_bytes: Number(r.total_bytes ?? 0),
      table_bytes: Number(r.table_bytes ?? 0),
      index_bytes: Number(r.index_bytes ?? 0),
      row_estimate: Number(r.row_estimate ?? 0),
      seq_scan: Number(r.seq_scan ?? 0),
      idx_scan: Number(r.idx_scan ?? 0),
      n_live_tup: Number(r.n_live_tup ?? 0),
      n_dead_tup: Number(r.n_dead_tup ?? 0),
      last_vacuum: r.last_vacuum ? new Date(r.last_vacuum as string).toISOString() : null,
      last_autovacuum: r.last_autovacuum ? new Date(r.last_autovacuum as string).toISOString() : null,
      last_analyze: r.last_analyze ? new Date(r.last_analyze as string).toISOString() : null,
      last_autoanalyze: r.last_autoanalyze ? new Date(r.last_autoanalyze as string).toISOString() : null,
    }));
    const { error: snapErr } = await db.from("db_table_size_history").insert(snapshotRows);
    if (snapErr) console.warn(`[db-health] size snapshot insert failed: ${snapErr.message}`);

    // The prior day's snapshot (latest distinct captured_at strictly before this run, ≥20h back) for
    // the growth rate. None yet (first sweep) ⇒ no growth findings, just the snapshot — honest.
    const priorCutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    let prior: import("../src/lib/control-tower/db-health").TableSizeRow[] = [];
    const { data: priorBatch } = await db
      .from("db_table_size_history")
      .select("captured_at")
      .lt("captured_at", priorCutoff)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const priorCapturedAt = (priorBatch as { captured_at?: string } | null)?.captured_at;
    if (priorCapturedAt) {
      const { data: priorRows } = await db
        .from("db_table_size_history")
        .select("table_name, total_bytes, row_estimate, seq_scan, idx_scan, n_live_tup, n_dead_tup, last_autovacuum, captured_at")
        .eq("captured_at", priorCapturedAt);
      prior = ((priorRows ?? []) as Array<Record<string, unknown>>).map((r) => ({
        table_name: String(r.table_name ?? ""),
        total_bytes: Number(r.total_bytes ?? 0),
        row_estimate: Number(r.row_estimate ?? 0),
        seq_scan: Number(r.seq_scan ?? 0),
        idx_scan: Number(r.idx_scan ?? 0),
        n_live_tup: Number(r.n_live_tup ?? 0),
        n_dead_tup: Number(r.n_dead_tup ?? 0),
        last_autovacuum: (r.last_autovacuum as string | null) ?? null,
      }));
    }

    // Per-index usage (pg_stat_user_indexes) for the unused-index proposal.
    const idxRes = await c.query(
      `select t.relname as table_name,
              i.relname as index_name,
              coalesce(psi.idx_scan, 0)::bigint as idx_scan,
              pg_relation_size(i.oid)::bigint as index_bytes,
              ix.indisunique as is_unique,
              ix.indisprimary as is_primary
         from pg_index ix
         join pg_class i on i.oid = ix.indexrelid
         join pg_class t on t.oid = ix.indrelid
         join pg_namespace n on n.oid = t.relnamespace
         left join pg_stat_user_indexes psi on psi.indexrelid = i.oid
        where n.nspname = 'public' and t.relkind = 'r'`,
    );
    const indexes: import("../src/lib/control-tower/db-health").IndexStatRow[] = (idxRes.rows as Array<Record<string, unknown>>).map((r) => ({
      table_name: String(r.table_name ?? ""),
      index_name: String(r.index_name ?? ""),
      idx_scan: Number(r.idx_scan ?? 0),
      index_bytes: Number(r.index_bytes ?? 0),
      is_unique: Boolean(r.is_unique),
      is_primary: Boolean(r.is_primary),
    }));

    // Phase 2 — the trailing size-history WINDOW (incl. the just-inserted current batch) for the trend
    // projection: growth-to-ceiling + the autovacuum-lag trend. Bounded to the currently-big tables (the
    // only ones a trend can flag) so the row count stays well under PostgREST's default cap. Honest:
    // <TREND_MIN_POINTS snapshots ⇒ no trend findings, just the spike/single-snapshot ones.
    let history: import("../src/lib/control-tower/db-health").TableSizeRow[] = [];
    const bigTableNames = tables.filter((t) => t.total_bytes >= mod.SIZE_MIN_BYTES).map((t) => t.table_name);
    if (bigTableNames.length > 0) {
      const trendWindowStart = new Date(Date.now() - DB_HEALTH_TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data: histRows } = await db
        .from("db_table_size_history")
        .select("table_name, total_bytes, row_estimate, seq_scan, idx_scan, n_live_tup, n_dead_tup, last_autovacuum, captured_at")
        .in("table_name", bigTableNames)
        .gte("captured_at", trendWindowStart)
        .order("captured_at", { ascending: true })
        .limit(5000);
      history = ((histRows ?? []) as Array<Record<string, unknown>>).map((r) => ({
        table_name: String(r.table_name ?? ""),
        total_bytes: Number(r.total_bytes ?? 0),
        row_estimate: Number(r.row_estimate ?? 0),
        seq_scan: Number(r.seq_scan ?? 0),
        idx_scan: Number(r.idx_scan ?? 0),
        n_live_tup: Number(r.n_live_tup ?? 0),
        n_dead_tup: Number(r.n_dead_tup ?? 0),
        last_autovacuum: (r.last_autovacuum as string | null) ?? null,
        captured_at: (r.captured_at as string | null) ?? undefined,
      }));
    }

    const findings = [
      ...mod.analyzeGrowth(tables, prior),
      ...mod.analyzeGrowthTrend(history, Date.now()),
      ...mod.analyzeIndexUsage(tables, indexes),
      ...mod.analyzeBloat(tables, Date.now()),
      ...mod.analyzeBloatTrend(history, Date.now()),
    ];
    const proposed = await surfaceDbHealthFindings(findings);
    const top = tables.slice(0, 10).map((t) => ({ table: t.table_name, total_bytes: t.total_bytes, row_estimate: t.row_estimate }));
    await writeCronHeartbeat(
      mod.DB_HEALTH_SIZE_LOOP_ID,
      true,
      { status: "ok", tables_snapshotted: tables.length, had_prior: prior.length > 0, history_rows: history.length, findings: findings.length, proposed, top },
      Date.now() - startedAt,
      `db-health size sweep — ${tables.length} tables, ${mod.summarizeFindings(findings)}, ${proposed} proposed`,
    );
    console.log(`[db-health] size sweep — ${tables.length} tables snapshotted, ${findings.length} findings, ${proposed} proposed`);
  } catch (e) {
    console.error("[db-health] size sweep failed:", e instanceof Error ? e.message : String(e));
  } finally {
    if (c) await c.end().catch(() => {});
  }
}

// Owner Build on a surfaced db_health proposal (resume on queued_resume). Materialize the pre-authored
// fix spec to main + queue the build — the owner-gate. (Dismiss resolves directly in the POST route.)
async function runDbHealthJob(job: Job) {
  const tag = `[db_health:${job.id.slice(0, 8)}]`;
  let instr: { signature?: string; spec_slug?: string; spec_body?: string } = {};
  try {
    instr = job.instructions ? JSON.parse(job.instructions) : {};
  } catch {
    /* not JSON — fall back to spec_slug as the signature */
  }
  const signature = instr.signature || job.spec_slug;
  const buildAction = (job.pending_actions || []).find((a) => a.type === "db_health_build");
  if (buildAction && (buildAction.status === "approved" || buildAction.status === "declined")) {
    if (buildAction.status === "approved" && buildAction.spec_slug) {
      const dupe = await hasActiveBuildForSlug(buildAction.spec_slug);
      if (dupe.active) {
        buildAction.status = "done";
        buildAction.result = `build already live for ${buildAction.spec_slug} (${dupe.reason}) — not re-queued`;
        await update(job.id, { status: "completed", pending_actions: job.pending_actions, log_tail: `owner Build → ${buildAction.result}`.slice(-2000) });
        console.log(`${tag} owner Build → dedup: ${buildAction.result}`);
        return;
      }
      // db-health-spec-body-robust: resolve the body from the un-clobberable action (re-deriving from the
      // carried finding if it's empty) BEFORE committing — never author a 0-byte spec.
      const bodyResult = await resolveDbHealthSpecBody(buildAction, instr);
      if ("error" in bodyResult) {
        buildAction.result = `cannot author spec body: ${bodyResult.error}`;
        await update(job.id, {
          status: "needs_input",
          error: `db_health: ${bodyResult.error} — refused to commit an empty spec`,
          questions: [{ id: "spec_body", q: `The DB Health fix spec for \`${signature}\` has an empty body and can't be reconstructed (${bodyResult.error}). Re-run the DB Health pass to regenerate the proposal, or paste the fix spec body to author manually.` }],
          pending_actions: job.pending_actions,
          log_tail: `owner Build → empty spec body, re-derive failed: ${bodyResult.error}`.slice(-2000),
        });
        console.warn(`${tag} owner Build → empty spec body, re-derive failed: ${bodyResult.error}`);
        return;
      }
      const wrote = await materializeDbHealthSpec(buildAction.spec_slug, bodyResult.body, signature);
      if (!wrote) {
        await update(job.id, { status: "needs_attention", error: "spec commit failed", log_tail: `owner Build → failed to author docs/brain/specs/${buildAction.spec_slug}.md`.slice(-2000) });
        console.warn(`${tag} owner Build → spec commit failed`);
        return;
      }
      const { error } = await db.from("agent_jobs").insert({
        workspace_id: job.workspace_id,
        spec_slug: buildAction.spec_slug,
        kind: "build",
        status: "queued",
        created_by: job.created_by,
        instructions: `Build from DB Health Agent signature ${signature}. Follow the spec exactly; tsc-clean; open a PR. NEVER auto-apply DDL/deletes — the migration/apply-script lands in the PR for owner review.`,
      });
      buildAction.status = error ? "failed" : "done";
      buildAction.result = error ? `build enqueue failed: ${error.message}` : `queued build for ${buildAction.spec_slug}`;
      await update(job.id, { status: "completed", pending_actions: job.pending_actions, log_tail: `owner Build → ${buildAction.result}`.slice(-2000) });
      console.log(`${tag} owner Build → ${buildAction.result}`);
    } else {
      buildAction.result = "dismissed by owner";
      await update(job.id, { status: "completed", error: "dismissed by owner", pending_actions: job.pending_actions, log_tail: `owner Dismiss → cleared signature ${signature}`.slice(-2000) });
      console.log(`${tag} owner Dismiss → cleared`);
    }
    return;
  }
  // No actionable owner decision on the action — nothing to do (shouldn't normally be claimed). Park it.
  await update(job.id, { status: "needs_approval", log_tail: `awaiting owner Build/Dismiss for ${signature}`.slice(-2000) });
  console.log(`${tag} no owner decision yet — parked as needs_approval`);
}

// coverage-register-agent (coverage-auto-register-agent spec, Phase 1): the owner's decision on a surfaced
// unregistered-loop proposal. The proposal itself is authored deterministically by the deployed monitor
// (src/lib/coverage-register-agent.ts enqueueCoverageRegisterJob) — both fix-spec bodies (register +
// exempt) ride the job's instructions. This runner only materializes the CHOSEN fix spec to main + queues
// its build on the owner's tap (Register → land the MONITORED_LOOPS entry · Intentionally-unmonitored →
// add the INTENTIONALLY_UNMONITORED_CRONS exemption). The agent NEVER silently edits registry.ts.
async function runCoverageRegisterJob(job: Job) {
  const tag = `[coverage-register:${job.id.slice(0, 8)}]`;
  let instr: {
    signature?: string;
    loop_id?: string;
    register_spec_slug?: string;
    register_spec_body?: string;
    exempt_spec_slug?: string;
    exempt_spec_body?: string;
  } = {};
  try {
    instr = job.instructions ? JSON.parse(job.instructions) : {};
  } catch {
    /* not JSON — fall back to spec_slug as the signature */
  }
  const signature = instr.signature || job.spec_slug;
  const loopId = instr.loop_id || signature.replace("coverage-register:", "");

  const action = (job.pending_actions || []).find((a) => a.type === "coverage_register");
  if (action && (action.status === "approved" || action.status === "declined")) {
    if (action.status === "approved") {
      const register = action.decision !== "exempt"; // default to register
      const specSlug = register ? instr.register_spec_slug : instr.exempt_spec_slug;
      const specBody = register ? instr.register_spec_body : instr.exempt_spec_body;
      const what = register ? "register entry" : "intentionally-unmonitored exemption";
      if (!specSlug || !specBody) {
        await update(job.id, { status: "needs_attention", error: "no fix spec body to materialize", pending_actions: job.pending_actions, log_tail: `owner ${what} → missing spec body for ${loopId}`.slice(-2000) });
        console.warn(`${tag} owner ${what} → missing spec body`);
        return;
      }
      // Auto-build dedup: never enqueue a second build / open a 4th identical PR for a slug already live.
      const dupe = await hasActiveBuildForSlug(specSlug);
      if (dupe.active) {
        action.status = "done";
        action.result = `build already live for ${specSlug} (${dupe.reason}) — not re-queued`;
        await update(job.id, { status: "completed", pending_actions: job.pending_actions, log_tail: `owner ${what} → ${action.result}`.slice(-2000) });
        console.log(`${tag} owner ${what} → dedup: ${action.result}`);
        return;
      }
      const wrote = await materializeDbHealthSpec(specSlug, specBody, signature);
      if (!wrote) {
        await update(job.id, { status: "needs_attention", error: "spec commit failed", pending_actions: job.pending_actions, log_tail: `owner ${what} → failed to author docs/brain/specs/${specSlug}.md`.slice(-2000) });
        console.warn(`${tag} owner ${what} → spec commit failed`);
        return;
      }
      const { error } = await db.from("agent_jobs").insert({
        workspace_id: job.workspace_id,
        spec_slug: specSlug,
        kind: "build",
        status: "queued",
        created_by: job.created_by,
        instructions: `Build from coverage-register agent (${what} for loop ${loopId}). Follow the spec exactly — a small src/lib/control-tower/registry.ts edit; tsc-clean; open a PR.`,
      });
      action.status = error ? "failed" : "done";
      action.result = error ? `build enqueue failed: ${error.message}` : `queued build for ${specSlug}`;
      await update(job.id, { status: "completed", pending_actions: job.pending_actions, log_tail: `owner ${what} → ${action.result}`.slice(-2000) });
      console.log(`${tag} owner ${what} → ${action.result}`);
    } else {
      action.result = "dismissed by owner";
      await update(job.id, { status: "completed", error: "dismissed by owner", pending_actions: job.pending_actions, log_tail: `owner Dismiss → cleared ${loopId}`.slice(-2000) });
      console.log(`${tag} owner Dismiss → cleared`);
    }
    return;
  }
  // No actionable owner decision — shouldn't normally be claimed. Park it.
  await update(job.id, { status: "needs_approval", log_tail: `awaiting owner decision for ${loopId}`.slice(-2000) });
  console.log(`${tag} no owner decision yet — parked as needs_approval`);
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

  // Multi-account (box-multi-account-failover Phase 1): plan shares the build/plan pool, so round-robin a
  // NEW plan across healthy accounts and PIN a resume to its session's owning account. A plan RESUME
  // authoring approved specs is NOT idempotent (a fresh session would re-propose, not author), so it can't
  // start fresh — if its owning account is capped it WAITS (blocked_on_usage) for that account.
  const decision = resolveAccountForJob(job, isResume, /* canStartFresh */ false);
  if (decision.kind === "blocked") {
    await update(job.id, {
      status: "blocked_on_usage",
      error: `Max account capped — plan auto-resumes after ~${new Date(decision.resetAt).toISOString()}`,
      log_tail: `parked blocked_on_usage; account reset ~${new Date(decision.resetAt).toISOString()}`,
    });
    console.warn(`${tag} owning account capped → blocked_on_usage (reset ~${new Date(decision.resetAt).toISOString()})`);
    return;
  }
  const configDir = decision.configDir;
  const sessionId = decision.sessionId;
  const chosenAccount = accountByDir.get(configDir)!;
  chosenAccount.inFlight++;
  chosenAccount.lastAssignedAt = Date.now();

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
        `SELF-SEQUENCING (goal-decomposition-encodes-blockers): every proposed branch MUST declare its prerequisites as \`blocked_by\`: a (possibly empty) list of the slugs it depends on — each slug MUST reference another proposed spec in THIS tree or an already-existing spec under docs/brain/specs/. The graph MUST be acyclic (no spec blocks itself, directly or transitively). Foundation specs that nothing precedes have \`blocked_by: []\`; a spec that needs a framework/memory/metric built first lists those slugs. Do NOT over-serialize independent branches — only list a real build-order dependency. The approved tree becomes self-sequencing: only unblocked specs build immediately, dependents auto-queue as their blockers ship.`,
        `Final message = ONLY one JSON object: {"status":"needs_approval","actions":[{"type":"spec","summary":"<title>","preview":"<intent>\\n\\nGap: <brain citation>","spec":{"slug":"…","title":"…","owner":"…","parent":"…","milestone":"…","intent":"…","gap":"…","blocked_by":["<sibling-or-existing-slug>"]}}]} | {"status":"completed","summary":"…"} | {"status":"needs_input","questions":[{"id":"q1","q":"…"}]}.`,
      ].join("\n");
      const { session, resultText, isError, raw } = await runClaude(prompt, sessionId, wt, configDir);
      if (session) await update(job.id, { claude_session_id: session, claude_session_config_dir: configDir });
      if (isError && isUsageCapError(`${resultText}\n${raw}`)) {
        await handlePoolUsageCap(job.id, tag, configDir, !!session, raw.slice(-2000));
        return;
      }
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
              // Prerequisite slugs (goal-decomposition-encodes-blockers). Keep only string slugs;
              // a missing/malformed list → no declared blockers (the spec authors with no Blocked-by).
              blocked_by: Array.isArray(sp.blocked_by)
                ? (sp.blocked_by as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0)
                : undefined,
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

    // Approved-blockers-only (goal-decomposition-encodes-blockers): a proposed blocker the owner DECLINED
    // is dropped so a spec isn't permanently blocked by a branch that will never ship. Approved siblings
    // and already-existing specs (slugs not in this proposal at all) are kept.
    const declinedSlugs = new Set(declined.map((a) => a.spec!.slug));
    const specList = approved
      .map((a, i) => {
        const s = a.spec!;
        const blockers = (s.blocked_by ?? []).filter((b) => b !== s.slug && !declinedSlugs.has(b));
        const blockedLine = blockers.length ? `\n   blocked_by: ${blockers.join(", ")}` : "";
        return `${i + 1}. slug=${s.slug} · title="${s.title}" · owner=${s.owner} · parent="${s.parent}"${s.milestone ? ` · milestone=${s.milestone}` : ""}\n   intent: ${s.intent}${s.gap ? `\n   gap: ${s.gap}` : ""}${blockedLine}`;
      })
      .join("\n");
    const declinedNote = declined.length
      ? `\n\nDECLINED branches (record as ❌ under a "## Declined branches" section in the goal doc so re-plan never re-proposes them): ${declined.map((a) => a.spec!.slug).join(", ")}.`
      : "";
    const prompt = [
      `Author the owner-APPROVED specs for goal docs/brain/goals/${goalSlug}.md (cwd is the repo root). Do NOT build anything; do NOT run git. Only write files under docs/brain/specs/ and edit docs/brain/goals/${goalSlug}.md.`,
      `For EACH approved spec below, create docs/brain/specs/{slug}.md as a real, concrete build spec: an H1 "# {Title} ⏳"; directly under it the metadata line \`**Owner:** [[../functions/{owner}]] · **Parent:** {parent}\`; a one-paragraph summary tied to the goal's success metric; concrete "## Phase N — name" sections (each first bullet "- ⏳ planned") grounded in the brain (read pages to cite real table/library names + the gap); a "## Safety / invariants" section; a "## Completion criteria" section. Match the style of existing docs/brain/specs/*.md.`,
      `BLOCKED-BY (goal-decomposition-encodes-blockers): when an approved spec below lists \`blocked_by\`, add a metadata header line immediately after the \`**Owner:** … · **Parent:** …\` line, in exactly this format: \`**Blocked-by:** [[<slug>]], [[<slug>]]\` (one [[slug]] wikilink per blocker, comma-separated). This gates the spec's build until its prerequisites ship. If a spec has no \`blocked_by\` line below, do NOT add a Blocked-by header (it is a foundation spec that builds immediately). Use ONLY the slugs listed in that spec's \`blocked_by\` — do not invent prerequisites.`,
      `Then update docs/brain/goals/${goalSlug}.md: under the matching milestone in "## Decomposition", add a wikilink to each new spec, e.g. "[[../specs/{slug}]] ⏳ — {one-line}".${declinedNote}`,
      ``,
      `Approved specs:\n${specList}`,
      ``,
      `Final message = ONLY {"status":"completed","summary":"authored N specs: …"} (or {"status":"needs_input","questions":[…]} only if a spec is genuinely under-specified).`,
    ].join("\n");

    const { session, resultText, isError, raw } = await runClaude(prompt, sessionId, wt, configDir);
    if (session) await update(job.id, { claude_session_id: session, claude_session_config_dir: configDir });
    if (isError && isUsageCapError(`${resultText}\n${raw}`)) {
      await handlePoolUsageCap(job.id, tag, configDir, !!session, raw.slice(-2000));
      return;
    }
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
    // Route through queueRoadmapBuild (the single enqueue chokepoint) so this agent path honours the
    // SAME spec-blockers gate as the dashboard + Slack: a freshly-authored spec that declares an
    // unshipped `Blocked-by` is refused here too, instead of inserting a build row that would collide.
    // (spec-blockers Phase 2.) Owner re-check + active-job dedupe come free from the chokepoint.
    const { queueRoadmapBuild } = await import("../src/lib/roadmap-actions");
    const queuedSlugs: string[] = [];
    const blockedSlugs: string[] = [];
    for (const a of approved) {
      const s = a.spec!;
      const res = await queueRoadmapBuild(job.workspace_id, job.created_by ?? "", {
        slug: s.slug,
        instructions: `Authored by the goal planner for ${goalSlug} (${s.parent}).`,
      });
      if (res.ok) queuedSlugs.push(s.slug);
      else if (res.status === 409) blockedSlugs.push(s.slug);
      else console.error(`${tag} queueRoadmapBuild failed for ${s.slug}: ${res.status} ${res.error}`);
    }

    const acted = actions.map((a) =>
      a.type === "spec" && a.status === "approved"
        ? {
            ...a,
            status: "done" as const,
            result: queuedSlugs.includes(a.spec!.slug)
              ? "authored + build queued"
              : blockedSlugs.includes(a.spec!.slug)
                ? "authored (build blocked — prerequisite not shipped)"
                : "authored",
          }
        : a.type === "spec" && a.status === "declined"
          ? { ...a, status: "done" as const, result: "recorded ❌" }
          : a,
    );
    await update(job.id, {
      status: "completed",
      pending_actions: acted,
      log_tail: `committed ${committed} docs to main; queued ${queuedSlugs.length} builds: ${queuedSlugs.join(", ")}${blockedSlugs.length ? `; ${blockedSlugs.length} blocked: ${blockedSlugs.join(", ")}` : ""}`,
    });
    console.log(`${tag} ✓ authored ${approved.length} specs → queued ${queuedSlugs.length} builds`);
  } finally {
    chosenAccount.inFlight--; // release the account's round-robin load slot
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

// ── directors-board-gamified Phase 2: post a routed answer-brain reply back onto the #directors board ──
// When a dev-ask/spec-chat turn was triggered from the board (the CEO replied "why?" under a director's
// post), its job instructions carry a BoardReplyLink. After the turn lands, post the box's answer straight
// back as the director's threaded `reply` so the channel reads as a two-way conversation. Best-effort —
// a board write must never fail the underlying turn.
type BoardReplyLink = { postId?: string; workspaceId?: string; authorFunction?: string };
async function postBoardAnswer(
  board: BoardReplyLink | undefined,
  reply: string,
  threadId: string,
  source: "dev-ask" | "spec-chat",
) {
  if (!board?.postId || !board.workspaceId || !reply) return;
  try {
    await db.from("director_messages").insert({
      workspace_id: board.workspaceId,
      author: "director",
      author_function: board.authorFunction ?? "platform",
      body: reply,
      kind: "reply",
      parent_message_id: board.postId,
      mentions: ["ceo"],
      metadata: { thread_id: threadId, source },
    });
  } catch (e) {
    console.error(`[board-answer] post-back failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runSpecChatJob(job: Job) {
  const tag = `[spec-chat:${job.id.slice(0, 8)}]`;
  let params: { mode?: string; chat_id?: string; slug?: string; seedSlug?: string; queueBuild?: boolean; board?: BoardReplyLink } = {};
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
      await postBoardAnswer(params.board, reply, chatId!, "spec-chat");
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
  const { selectEscalatedForTriage, loadTriageBrief, materializeTriageOutcome, recordTriageRun, handUpExhaustedTriage, postTriageNote } = await import(
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
      // Paper trail: the routine is taking a stab at this escalated ticket. Internal-only — a human
      // reading the thread sees the AI is on it and can still step in (escalate to a person).
      await postTriageNote(db, ticketId, "[AI Investigation] Looking into this escalated ticket (solver → skeptic → quorum)…").catch(() => {});

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
        await postTriageNote(db, ticketId, "[AI Investigation] no quorum — left escalated for a human.").catch(() => {});
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
        // Outcome note (internal) describing what the routine did with this escalated ticket.
        if (mat.todoCount > 0) {
          await postTriageNote(db, ticketId, `[AI Investigation] proposed ${mat.todoCount} todo${mat.todoCount === 1 ? "" : "s"} for approval — see the To Do queue.`).catch(() => {});
        } else if (proposal.decision === "escalation_false_positive") {
          // Quorum-confirmed mis-escalation → un-escalate (leave AI-Investigation); the analyzer-fix
          // spec mat committed handles the systemic cause. Keep escalated_to null (already null).
          await db.from("tickets").update({ escalated_at: null, updated_at: new Date().toISOString() }).eq("id", ticketId);
          await postTriageNote(db, ticketId, `[AI Investigation] mis-escalation — un-escalated${mat.specPath ? " (filed an analyzer-fix spec)" : ""}.`).catch(() => {});
        } else {
          await postTriageNote(db, ticketId, `[AI Investigation] ${mat.summary}.`).catch(() => {});
        }
        await recordTriageRun(db, {
          id: triageRunId, workspaceId: wsId, jobId: job.id, ticketId, decision: proposal.decision, verdict: "agree",
          materialized: true, outcome: mat.summary, solverTranscript, skepticTranscript, groupId: mat.groupId ?? null,
        });
        summaries.push(`${ticketId.slice(0, 8)}: agree·${proposal.decision} → ${mat.summary}`);
        console.log(`${tag} ${ticketId.slice(0, 8)} AGREE (${proposal.decision}) → ${mat.summary}`);
      } else {
        const outcome = `no quorum (solver=${proposal.decision}, skeptic=${finalVerdict})${verdict?.critique ? `: ${verdict.critique.slice(0, 300)}` : ""}`;
        await postTriageNote(db, ticketId, "[AI Investigation] no quorum — left escalated for a human.").catch(() => {});
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
      `SANDBOX CHECK (spec-test-deep-verification Phase 2) — a FIFTH non-destructive mode for INTERNAL-ONLY BEHAVIORAL bullets. A bullet shaped "fire event / call POST / approve → assert DB rows + customer_events/triage_runs" whose EVERY side effect is internal (a DB write or an Inngest event) is a SANDBOX check (\`auto\`, pass/fail), NOT needs_human — drive it on dedicated \`is_test\` fixtures, assert the rows/events, then clean up. Run it with \`npx tsx scripts/spec-test-sandbox.ts\`: \`info\` (fixtures + the internal-only flow registry + forbidden external APIs), \`isolation\` (non-test-workspace fingerprint), \`fire <flowId>\` (fire an allowlisted internal-only event — e.g. \`comp-renewal-failclosed\` — it proves the precondition, asserts the rows/events, and reports \`isolation.zero_non_test_workspace_writes\`), \`post <flowId> [--body '<json>'|--clear]\` (call an allowlisted internal POST with owner cookies scoped to the is_test workspace — e.g. \`human-queue-resolve\`, \`roadmap-answer\`), \`cleanup\` (idempotent reset). Cite the tool's \`pass\` + per-assertion booleans + \`isolation.zero_non_test_workspace_writes:true\` as evidence; run \`cleanup\` after. Observing the wrong row/event state IS breakage evidence → a sandbox-check \`fail\` is legitimate.`,
      `🚨 EXTERNAL SIDE-EFFECT FIREWALL (the core Phase-2 safety rule) — drive a flow ONLY if you can PROVE every side effect stays internal. A flow that would call an EXTERNAL API with real effect — Amplifier fulfillment, a Braintree charge/refund, an Appstle mutation, a Resend/Twilio send, a live Meta ad pause — is NOT run; it stays needs_human. Prove it by reading the handler: assert UP TO the external edge and flag the edge itself human (e.g. comp renewal: the fail-closed branch — comp sub + comp_role null → failed type='comp' txn + subscription.comp_renewal_failed event, no order, no advance — is fully internal → SANDBOX; the happy branch's Amplifier handoff is external → that sub-assertion stays needs_human). The toolkit only drives flows in INTERNAL_ONLY_FLOWS and refuses any non-is_test workspace; the is_test tenant also carries NO external credentials. ALWAYS also assert ZERO writes to non-test-workspace rows (the tool's \`isolation.zero_non_test_workspace_writes\`).`,
      `\`needs_human\` is now EXACTLY TWO cases: (a) VISUAL/AESTHETIC judgment (looks good / renders nicely / big enough — human taste is the only instrument; a RENDERED-FACT assertion like "the stamp/chip is present" is a BROWSER check, not this), and (b) an IRREVERSIBLE PROD SIDE-EFFECT with NO already-observable evidence AND NO local-harness/browser/sandbox equivalent (a real SMS/email/charge actually reaching an external carrier/processor, a UI flow that can only be verified by submitting a real customer/billing mutation, or a behavioral flow that CROSSES THE EXTERNAL FIREWALL — the side effect would hit Amplifier/Braintree/Appstle/Resend/Twilio/Meta with real effect). An internal-only behavioral flow on \`is_test\` fixtures is a SANDBOX check (auto), not this. Everything else attempts a non-destructive verification.`,
      `🚨 \`fail\` REQUIRES POSITIVE EVIDENCE OF BREAKAGE — you ran a non-destructive check (incl. a local harness) and OBSERVED the feature doing the wrong thing (a column it claims to select isn't there; a route 500s; a role check returns the wrong status; the harness returned the wrong state). "I couldn't verify this read-only" is NOT a fail. A fault-injection bullet is \`auto\` (pass/fail) whenever the logic is reachable as a local unit; only when it is NOT reachable locally (needs forcing a fault in a live prod runtime path, a mutation, or visual/UX judgment) is it \`needs_human\` (a human can verify it), NEVER \`fail\`. Genuinely undeterminable (missing fixture, ambiguous bullet) → \`inconclusive\`. When the code plainly satisfies a bullet but the runtime path needs a forced fault AND the logic isn't reachable locally, prefer \`needs_human\` with a note ("code present at file:line; not reachable as a local unit, needs forced fault to confirm") over \`fail\`. Only evidence-backed \`fail\`s become regressions / flip the verdict to \`issues\`; \`needs_human\`/\`inconclusive\` never do.`,
      `TIE-BREAKER (replaces "when in doubt → needs_human"): when in doubt, attempt a read-only outcome probe first, then a non-destructive local harness, then (rendered-UI) a browser check, then (internal-only behavioral) a sandbox check; defer to \`needs_human\` ONLY if ALL are impossible OR the flow crosses the external firewall.`,
      `You have the box's QA toolkit: repo Read/Grep + \`npx tsc --noEmit\`, the \`gh\` CLI for CI/PR status, the \`vercel\` CLI for deploy READY + logs + \`vercel env ls\`, read-only DB probes via \`npx tsx scripts/spec-test-db-probe.ts "<select …>"\`, GET/read-only endpoint hits, a non-destructive local harness (\`_\`-prefixed scratch \`npx tsx\` script importing pure code from src/), the headless-browser check \`npx tsx scripts/spec-test-browser-check.ts\` (owner-authed, READ-ONLY render assertions + screenshot), and the behavioral sandbox \`npx tsx scripts/spec-test-sandbox.ts\` (drives INTERNAL-ONLY flows on is_test fixtures, asserts, proves isolation — bounded by the external firewall). NEVER mutate REAL prod data, NEVER mark the spec verified/archived, NEVER run a check that hits a real customer/dollar/external API (those are needs_human), NEVER submit a mutating form in the browser, NEVER point the sandbox at a non-is_test workspace.`,
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
    // Mark THIS spec-test job terminal BEFORE the auto-fold gate runs. fold-guard-live-build (Phase 1)
    // makes a spec with a live build/spec-test job ineligible for auto-fold — and this very job is a live
    // spec-test job for `slug` until it's completed. Flipping it first means the gate sees no live job for
    // the spec it just tested (only a genuinely-separate in-flight build would block it, which is correct).
    await update(job.id, {
      status: "completed",
      log_tail: `${agent_verdict} — ✅${summary.auto_pass} ✗${summary.auto_fail} 👤${summary.needs_human} ?${summary.inconclusive}. ${report}`.slice(-2000),
    });
    // Auto-fold Gate B (auto-ship-pipeline Phase 2): an `approved` run with no waiting/failed human checks
    // + no regressions just made this spec all-green → auto-archive it (enqueue_fold), no owner click.
    // All-green-only + kill-switched inside the gate. Best-effort — never fail the spec-test run.
    try {
      const { autoFoldVerifiedSpecs } = await import("../src/lib/spec-test-runs");
      const f = await autoFoldVerifiedSpecs(job.workspace_id, db);
      if (f.folded > 0) console.log(`${tag} auto-folded ${f.folded} fully-verified spec(s): ${f.foldedSlugs.join(", ")}`);
    } catch (e) {
      console.error(`${tag} auto-fold gate failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
    // Regression detector (regression-agent Phase 1): an `issues` run on a SHIPPED spec means a ✅
    // verification no longer holds — a regression (false-✅ / drift). Enqueue a regression review (the
    // worker reviews → dismiss or author a fix spec directly → the DevOps Director queues the build).
    // getHumanTestQueue applies the exact regression definition (shipped + unarchived + UNRESOLVED
    // evidence-backed fails); we filter to the slug just tested. Best-effort — never fail the run.
    if (agent_verdict === "issues") {
      try {
        const { getHumanTestQueue } = await import("../src/lib/spec-test-runs");
        const { enqueueRegressionJob } = await import("../src/lib/regression-agent");
        const q = await getHumanTestQueue(job.workspace_id);
        const reg = q.regressions.find((r) => r.slug === slug);
        if (reg) {
          const r = await enqueueRegressionJob(db, {
            workspaceId: job.workspace_id,
            specSlug: reg.slug,
            title: reg.title,
            failing: reg.failing,
            runAt: reg.run_at,
          });
          console.log(`${tag} regression on ${slug} → ${r.enqueued ? `enqueued review (${r.reason})` : `not enqueued (${r.reason})`}`);
        }
      } catch (e) {
        console.error(`${tag} regression detector failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
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
  let params: { thread_id?: string; mode?: string; board?: BoardReplyLink } = {};
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
    await postBoardAnswer(params.board, reply, threadId, "dev-ask");
    await update(job.id, { status: "completed", log_tail: logTail });
    console.log(`${tag} ✓ reply appended${newActions.length ? ` (+${newActions.length} pending action[s])` : ""}`);
  } finally {
    sh("git", ["worktree", "remove", "--force", wt]);
  }
}

// ── Dirty-PR resolver (dirty-pr-resolver-agent) ─────────────────────────────
// A Max `claude -p` that merges origin/main into a dirty claude/* PR + resolves the conflicts. Same
// sandbox as a feature build (no ANTHROPIC_API_KEY, prod secrets stripped — NO prod creds), but it only
// runs LOCAL git + tsc + file edits: it does NOT push (the worker re-verifies + pushes) and has no gh.
async function runPrResolveClaude(prompt: string, sessionId: string | null, cwd: string) {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "ANTHROPIC_API_KEY") continue;
    if (/^NEXT_PUBLIC_/.test(k)) { env[k] = v; continue; }
    if (SECRET_RE.test(k)) continue; // drops GITHUB_TOKEN too → the LLM can't push; the worker does
    env[k] = v;
  }
  const base = sessionId ? ["--resume", sessionId] : [];
  const args = [...base, "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json"];
  const r = await shAsync("claude", args, { cwd, env, timeout: PR_RESOLVE_TIMEOUT_MS });
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

// Surface a PR that can't be auto-resolved (and isn't a re-buildable spec build) to the owner — a
// Control Tower / Slack note per the North Star ("escalate, don't guess"). Best-effort.
async function surfacePrToOwner(workspaceId: string, prNumber: number, prUrl: string, why: string) {
  try {
    const { notifyOpsAlert } = await import("../src/lib/notify-ops-alert");
    await notifyOpsAlert(workspaceId, {
      title: `Control Tower: PR #${prNumber} needs a human merge`,
      severity: "warning",
      lines: [why, prUrl],
    });
  } catch (e) {
    console.error(`[pr-resolve] surface PR #${prNumber} failed:`, e instanceof Error ? e.message : String(e));
  }
}

// Resolve ONE dirty claude/* PR: worktree the branch → claude merges origin/main + resolves additively
// → the WORKER runs the tsc GATE + correctness checks + pushes (never a non-compiling merge). On a
// heavy parallel-rewrite divergence or a merge that can't compile, it does NOT force a wrong merge:
// it rebuilds the originating spec on main (close PR + re-queue off clean main) or — if it can't
// identify the spec — surfaces "needs a human merge: {why}" to the owner. Capped, idempotent, deduped.
async function runPrResolveJob(job: Job) {
  const tag = `[pr-resolve:${job.id.slice(0, 8)}]`;
  const wsId = job.workspace_id;
  let params: { pr_number?: number; branch?: string; reason?: string } = {};
  try { params = job.instructions ? JSON.parse(job.instructions) : {}; } catch { /* not JSON */ }
  const prNumber = params.pr_number ?? job.pr_number ?? Number(String(job.spec_slug).replace(/\D/g, ""));
  const branch = params.branch || job.spec_branch || "";

  // Guardrail: claude/* build branches ONLY — never touch a human PR or main.
  if (!branch || !branch.startsWith("claude/")) {
    await update(job.id, { status: "completed", error: "skipped: not a claude/* branch", log_tail: `refused to touch non-claude branch ${branch || "(none)"}` });
    console.log(`${tag} refused non-claude branch "${branch}" — skipping`);
    return;
  }
  if (!prNumber || Number.isNaN(prNumber)) {
    await update(job.id, { status: "failed", error: "no PR number in job", log_tail: job.instructions || "" });
    return;
  }

  // Re-check PR state (idempotent / de-duped): only act on an OPEN, not-already-MERGEABLE PR. mergeable
  // can be null (GitHub still computing) → re-check briefly; if still unknown, attempt anyway (the
  // webhook flagged it CONFLICTING). already mergeable / merged / closed → no-op completed.
  const prResp = await gh("GET", `/repos/${REPO}/pulls/${prNumber}`);
  const pr = prResp.json as { state?: string; merged?: boolean; mergeable?: boolean | null; html_url?: string; head?: { ref?: string } };
  const prUrl = pr.html_url || `https://github.com/${REPO}/pull/${prNumber}`;
  if (!prResp.ok || pr.state !== "open" || pr.merged) {
    await update(job.id, { status: "completed", pr_url: prUrl, pr_number: prNumber, log_tail: `PR #${prNumber} no longer open (state=${pr.state} merged=${pr.merged}) — nothing to resolve` });
    console.log(`${tag} PR #${prNumber} not open (state=${pr.state}) — no-op`);
    return;
  }
  if (pr.head?.ref && pr.head.ref !== branch) {
    await update(job.id, { status: "completed", error: "branch changed", log_tail: `PR #${prNumber} head is now ${pr.head.ref}, expected ${branch}` });
    return;
  }
  let mergeable = pr.mergeable;
  for (let i = 0; mergeable == null && i < 3; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const re = await gh("GET", `/repos/${REPO}/pulls/${prNumber}`);
    mergeable = (re.json as { mergeable?: boolean | null }).mergeable ?? null;
  }
  if (mergeable === true) {
    await update(job.id, { status: "completed", pr_url: prUrl, pr_number: prNumber, log_tail: `PR #${prNumber} is already MERGEABLE — nothing to resolve` });
    console.log(`${tag} PR #${prNumber} already mergeable — no-op`);
    return;
  }

  // dirty-pr-resolver-duplicate-detection (Phase 1): if this PR's work already merged via a SIBLING build,
  // it is unresolvable by definition (its diff is already on main → merging main just re-conflicts). Close
  // it + delete the branch with a clear comment instead of burning a Max resolve pass on it.
  try {
    const { findAlreadyMergedDuplicate, closeDuplicatePr } = await import("../src/lib/github-pr-resolve");
    const dup = await findAlreadyMergedDuplicate(db, branch);
    if (dup) {
      const sib = dup.mergedPr ? `#${dup.mergedPr}` : (dup.mergedBranch ?? "a sibling build");
      const closed = await closeDuplicatePr(
        prNumber,
        branch,
        `Closing as a duplicate: this spec (\`${dup.specSlug}\`) already shipped via ${sib}, so this PR's changes are already on \`main\`. There is nothing left to merge — rebasing would only re-conflict. Auto-closed by the dirty-PR resolver (dirty-pr-resolver-duplicate-detection).`,
      );
      await update(job.id, {
        status: "completed",
        pr_url: prUrl,
        pr_number: prNumber,
        error: `closed-as-duplicate: ${dup.specSlug} already merged via ${sib}`,
        log_tail: `PR #${prNumber} is a duplicate of already-merged work (${dup.specSlug} via ${sib}) — ${closed ? "closed it + deleted the branch" : "close failed (left for the next event / human)"}; did NOT resolve.`,
      });
      console.log(`${tag} PR #${prNumber} duplicate of merged ${dup.specSlug} (${sib}) — ${closed ? "closed" : "close failed"}, no resolve`);
      return;
    }
  } catch (e) {
    console.error(`${tag} duplicate-check failed (continuing to resolve):`, e instanceof Error ? e.message : e);
  }

  const wt = join(BUILDS_DIR, job.id);
  sh("git", ["fetch", "origin"]);
  sh("git", ["worktree", "remove", "--force", wt]); // clear any leftover from a crashed run
  const add = sh("git", ["worktree", "add", "-B", branch, wt, `origin/${branch}`]);
  if (add.code !== 0) {
    await update(job.id, { status: "failed", error: "worktree add failed", log_tail: add.err.slice(-2000) });
    return;
  }
  sh("ln", ["-sfn", join(REPO_DIR, "node_modules"), join(wt, "node_modules")]);

  try {
    const prompt = [
      `You are the box's dirty-PR resolver, on Max. You are in a git worktree at the repo root, checked out on branch \`${branch}\` — a build PR (#${prNumber}). \`origin/main\` has moved ahead and this PR is CONFLICTING. Resolve it so the PR compiles and goes green — OR decide it can't be safely auto-resolved and say so. Do NOT guess.`,
      ``,
      `Steps:`,
      `1. Run \`git merge origin/main\`. If it merges with NO conflicts, skip to step 4.`,
      `2. Resolve EVERY conflict. The vast majority are ADDITIVE — both sides appended a registry entry / enum case / list item / import / doc section → KEEP BOTH (the union of the two additions). For a doc add/add on the same heading, keep the SHIPPED (origin/main) side. NEVER resolve a conflict by deleting code to "win" — that destroys the other build's work.`,
      `3. \`git add\` each resolved file.`,
      `4. Commit the merge: \`git commit --no-edit\` (only if a merge is in progress; a clean merge auto-commits).`,
      `5. Run \`npx tsc --noEmit\`. Fix ONLY errors the merge introduced and re-run — at most 2 attempts total. The merge MUST compile.`,
      `6. Do NOT \`git push\` and do NOT open/modify any PR — the worker re-verifies and pushes. Leave the merge committed on \`${branch}\`.`,
      ``,
      `DECISION — never force a semantically-wrong merge:`,
      `  • Simple/additive union that compiles → status "resolved".`,
      `  • The two sides are heavily-diverged PARALLEL REWRITES of the same logic (not a clean union), OR tsc still fails after 2 attempts → do NOT guess: run \`git merge --abort\` to leave the branch clean, then status "escalate" with a one-line \`reason\` (what diverged / why it can't compile).`,
      ``,
      `Final message = ONLY one JSON object:`,
      `  {"status":"resolved","summary":"<what you merged + how you resolved each conflict + the files>"}`,
      `  {"status":"escalate","reason":"<why it needs a human merge or a rebuild — one line>"}`,
    ].join("\n");

    const { session, resultText, isError, raw } = await runPrResolveClaude(prompt, null, wt);
    if (session) await update(job.id, { claude_session_id: session });
    const parsed = parseStatus(resultText) as { status?: string; reason?: string; summary?: string } | null;
    const reason = String(parsed?.reason || parsed?.summary || "").slice(0, 500);
    console.log(`${tag} claude finished — status=${parsed?.status ?? "(none)"} isError=${isError}`);

    // Escalate (rebuild-on-main if we can identify the spec build, else surface to the owner) for any
    // non-"resolved" outcome OR a failed worker gate. Capped: no pr-resolve retry loop — a rebuild
    // re-queues a fresh BUILD (clean base), a surface leaves needs_attention for a human.
    const escalate = async (why: string) => {
      sh("git", ["merge", "--abort"], { cwd: wt }); // leave the branch clean (best-effort; no-op if already committed)
      const { data: buildJob } = await db
        .from("agent_jobs")
        .select("spec_slug, instructions, workspace_id, created_by")
        .eq("spec_branch", branch)
        .eq("kind", "build")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const specSlug = buildJob?.spec_slug as string | undefined;
      if (specSlug && buildJob) {
        // rebuild-on-main: close the dirty PR + re-queue the build off a clean main (deduped).
        await gh("PATCH", `/repos/${REPO}/pulls/${prNumber}`, { state: "closed" });
        const { data: existing } = await db
          .from("agent_jobs")
          .select("id")
          .eq("workspace_id", buildJob.workspace_id)
          .eq("kind", "build")
          .eq("spec_slug", specSlug)
          .in("status", ["queued", "queued_resume", "claimed", "building", "needs_input", "needs_approval"])
          .limit(1)
          .maybeSingle();
        let requeued = false;
        if (!existing) {
          const { error: insErr } = await db.from("agent_jobs").insert({
            workspace_id: buildJob.workspace_id,
            spec_slug: specSlug,
            kind: "build",
            status: "queued",
            instructions: buildJob.instructions ?? null,
            created_by: buildJob.created_by ?? null,
          });
          requeued = !insErr;
        }
        try {
          const { notifyOpsAlert } = await import("../src/lib/notify-ops-alert");
          await notifyOpsAlert(wsId, {
            title: `Dirty-PR resolver: rebuilt ${specSlug} on main`,
            severity: "warning",
            lines: [`PR #${prNumber} couldn't be auto-merged (${why}) → closed it and ${requeued ? "re-queued the build" : "a build is already queued"} off a clean main.`, prUrl],
          });
        } catch { /* slack best-effort */ }
        await update(job.id, { status: "completed", pr_url: prUrl, pr_number: prNumber, error: `rebuilt-on-main: ${why}`, log_tail: `${why}\n→ closed PR #${prNumber}; ${requeued ? "re-queued" : "build already queued for"} ${specSlug} off main.\n\n${raw.slice(-1500)}` });
        console.log(`${tag} rebuild-on-main: closed PR #${prNumber}, re-queued ${specSlug}`);
      } else {
        // Can't identify the spec → a human must merge. Surface + needs_attention.
        await surfacePrToOwner(wsId, prNumber, prUrl, why);
        await update(job.id, { status: "needs_attention", pr_url: prUrl, pr_number: prNumber, error: `needs a human merge: ${why}`, log_tail: `${why}\n\n${raw.slice(-1500)}` });
        console.log(`${tag} surfaced PR #${prNumber} to owner: ${why}`);
      }
    };

    if (parsed?.status !== "resolved") {
      await escalate(reason || (isError ? "resolver run errored" : "resolver could not safely resolve the conflict"));
      return;
    }

    // ── Worker-enforced GATE (never trust the LLM to have pushed a compiling, complete merge) ──
    // 1) origin/main must actually be merged in (deterministic proof the merge happened).
    if (sh("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: wt }).code !== 0) {
      await escalate("merge incomplete — origin/main is not an ancestor of the resolved HEAD");
      return;
    }
    // 2) no unmerged paths left behind.
    if (sh("git", ["ls-files", "-u"], { cwd: wt }).out.trim()) {
      await escalate("unresolved conflicts remain (unmerged paths after the merge)");
      return;
    }
    // 3) no leftover conflict markers in tracked files (never resolve by leaving markers).
    const markers = sh("git", ["grep", "-l", "-E", "^(<<<<<<<|>>>>>>>) "], { cwd: wt }).out.trim();
    if (markers) {
      await escalate(`leftover conflict markers in: ${markers.split("\n").slice(0, 5).join(", ")}`);
      return;
    }
    // 4) the resolved merge MUST compile — the tsc gate. Never push a broken merge.
    const tsc = await shAsync("npx", ["tsc", "--noEmit"], { timeout: 10 * 60 * 1000, cwd: wt });
    if (tsc.code !== 0) {
      await escalate(`tsc failed on the resolved merge: ${(tsc.out + tsc.err).slice(-400)}`);
      return;
    }
    // 5) all gates pass → push the resolved merge → the PR flips CONFLICTING → MERGEABLE (green).
    const push = sh("git", ["push", "origin", `HEAD:${branch}`], { cwd: wt });
    if (push.code !== 0) {
      await escalate(`push failed: ${push.err.slice(-300)}`);
      return;
    }
    await update(job.id, { status: "completed", pr_url: prUrl, pr_number: prNumber, error: null, log_tail: `resolved + pushed: ${parsed?.summary || reason}\n${raw.slice(-1500)}` });
    console.log(`${tag} ✓ resolved PR #${prNumber}, pushed ${branch} → green`);
  } finally {
    sh("git", ["worktree", "remove", "--force", wt]);
  }
}

// ── Repair Agent (repair-agent) ──────────────────────────────────────────────
// A kind='repair' job is ONE event-fired Control Tower triage: the moment the Control Tower records
// a NEW problem (a new error_events signature via recordError, or a newly-opened loop_alert via the
// monitor) it enqueues a repair job (deduped by signature). The box INVESTIGATES read-only (the
// signature + sample + the implicated route/cron/fn, traced in the working tree), CLASSIFIES it, and
// ACTS: real bug / false-positive / noise → author a fix spec to main; transient → no-op + resolve
// the error row; can't diagnose → surface needs-human. Autonomy is surface-don't-auto-build: the
// DEFAULT authors the spec + SURFACES it for one-tap owner Build (it does NOT auto-queue the build);
// only a narrow mechanical allow-list (REPAIR_AUTOBUILD_KINDS) auto-queues. It NEVER edits product
// code / opens a PR / applies a migration — the build does that, owner-gated. (repair-agent Phase 1.)
async function runRepairClaude(prompt: string, sessionId: string | null, cwd: string) {
  // KEEP the env (read-only DB/crypto creds so the box can load + trace the error) — only strip the
  // API key so ALL LLM is Max-billed (never the Anthropic API). Web search stays on (investigation).
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const base = sessionId ? ["--resume", sessionId] : [];
  const args = [...base, "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json"];
  const r = await shAsync("claude", args, { cwd, env, timeout: REPAIR_TIMEOUT_MS });
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

// Load the read-only brief: the originating error_events signature + sample (or the loop_alert), so
// the box knows exactly what to trace. Best-effort — degrades to the instructions if a row is gone.
async function loadRepairBrief(instr: { source?: string; signature?: string; title?: string; error_event_id?: string | null; loop_alert_id?: string | null; members?: Array<{ source: string; signature: string; title: string }> }): Promise<string> {
  const lines: string[] = [`SIGNATURE: ${instr.signature}  ·  SOURCE: ${instr.source}`, `TITLE: ${instr.title}`, ``];
  try {
    if (instr.source === "cluster") {
      // A batched cluster job (per-cycle cap overflow): N signatures from one burst that LIKELY share
      // ONE root cause. Investigate the cluster together and author at most ONE fix spec for the
      // shared cause (the dedup grouping collapses siblings onto it).
      const members = Array.isArray(instr.members) ? instr.members : [];
      lines.push(`CLUSTER — ${members.length} signatures batched from one burst (cap overflow). They LIKELY share one root cause; find it and author ONE spec for the shared cause (NOT one per signature).`, ``);
      for (const m of members) lines.push(`  • [${m.source}] ${m.signature} — ${m.title}`);
      lines.push(``, `Trace the most likely SHARED implicated file/failure mode. If they genuinely differ, diagnose the dominant one and note the rest in the diagnosis.`);
    } else if (instr.source === "loop-alert") {
      const loopId = String(instr.signature || "").replace(/^loop:/, "");
      const { data: alert } = await db
        .from("loop_alerts")
        .select("loop_id, kind, reason, detail, opened_at, status")
        .eq("loop_id", loopId)
        .order("opened_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (alert) {
        lines.push(`LOOP ALERT — loop_id=${alert.loop_id} kind=${alert.kind} status=${alert.status}`);
        lines.push(`  reason: ${alert.reason}`);
        lines.push(`  detail: ${alert.detail}`);
        lines.push(`  opened_at: ${alert.opened_at}`);
        lines.push(``, `This is a Control Tower loop tile that went RED. Find the loop in src/lib/control-tower/registry.ts (id=${loopId}) and trace its implementation (its cron / agent / reactive fn). Decide: a REAL bug in the loop, a MONITOR false-positive (the loop is actually healthy but the assertion mis-fired), foreign-app noise, or a genuine transient.`);
      }
    } else {
      // An error_events incident — load by id if we have it, else by signature.
      let q = db.from("error_events").select("id, source, signature, title, detail, sample, count, status, first_seen_at, last_seen_at");
      q = instr.error_event_id ? q.eq("id", instr.error_event_id) : q.eq("signature", instr.signature || "");
      const { data: ev } = await q.order("last_seen_at", { ascending: false }).limit(1).maybeSingle();
      if (ev) {
        lines.push(`ERROR EVENT ${ev.id} — source=${ev.source} status=${ev.status} count=${ev.count}`);
        lines.push(`  title: ${ev.title}`);
        lines.push(`  detail: ${ev.detail ?? "—"}`);
        lines.push(`  first_seen: ${ev.first_seen_at}  ·  last_seen: ${ev.last_seen_at}`);
        lines.push(`  sample: ${JSON.stringify(ev.sample)?.slice(0, 2000) || "null"}`);
      } else {
        lines.push(`(error_events row not found — diagnose from the title/signature above)`);
      }
    }
  } catch (e) {
    lines.push(`(brief load degraded: ${e instanceof Error ? e.message : String(e)})`);
  }
  return lines.join("\n");
}

function repairPrompt(brief: string): string {
  return [
    `You are the box's Repair Agent on Max (web search on, no API key). You KEEP read access to prod, but you NEVER mutate and NEVER edit product code: you INVESTIGATE the error read-only, trace its ROOT CAUSE in the working tree (cwd is the repo root — read docs/brain/ first, then src/), classify it, and either propose a FIX SPEC (a doc) or no-op-resolve a transient. The actual code build is owner-gated and happens later — not now.`,
    `This is "escalation-triage, but for the Control Tower." A new problem was just recorded. Diagnose it.`,
    ``,
    brief,
    ``,
    `Trace the implicated code in the working tree, then decide ONE verdict (cite the root cause). The signature's SOURCE tells you WHERE to look: a server error (vercel/inngest/supabase) → a route / cron / Inngest function / library; a **\`source='client'\`** error is a BROWSER / React crash → trace the **client-side component or storefront/portal island for that error's surface + page** (e.g. surface \`storefront-pdp\` / \`storefront-customize\` / \`checkout\` / \`thank-you\` / \`portal\` — look in the storefront route's client components or shopify-extension/portal-src, NOT a server route). A real client bug is still "real-bug" (author a fix spec; owner likely \`[[../functions/growth]]\` for storefront / \`[[../functions/retention]]\` for portal).`,
    `  • "real-bug" — a genuine defect in OUR code. Author a single-phase, ~30-min-scoped fix spec. (Surfaced for owner Build — NOT auto-built, because it touches product code.)`,
    `  • "monitor-false-positive" — the Control Tower assertion mis-fired on a HEALTHY loop. Author a spec to fix the analyzer (add a grace / tighten the assertion) — monitor-only.`,
    `  • "foreign-app-noise" — a not-ours / foreign-app error leaking into a feed. Author a spec to SCOPE THE CAPTURE (filter it out) — monitor-only.`,
    `  • "transient" — a genuine wait / one-off blip with no code fix (a deploy-boundary race, a momentary upstream timeout that already recovered). NO spec — resolve the error and log why.`,
    `  • "needs-human" — you CANNOT confidently diagnose it (ambiguous, needs context only a human has). NO spec, no guess, no loop — surface it for a human with a plain one-line note.`,
    ``,
    `For any spec verdict, propose owner + parent (no orphan specs). Default owner "[[../functions/platform]]" and parent "extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]]" unless a more specific function clearly owns the implicated system. The spec must be a SINGLE phase scoped to a ~30-min build.`,
    ``,
    `Final message = ONLY one JSON object:`,
    `  {"status":"real-bug"|"monitor-false-positive"|"foreign-app-noise","diagnosis":"<plain text: the root cause + what the fix does>","spec":{"slug":"<stable-kebab-slug>","title":"...","owner":"[[../functions/platform]]","parent":"...","intent":"<one paragraph>","problem":"<concrete, grounded in the signature + the code you traced>","target":"src/lib/<the file/fn to fix>"}}`,
    `  {"status":"transient","reason":"<why this is a genuine wait/transient with no code fix>"}`,
    `  {"status":"needs-human","diagnosis":"<ONE-LINE plain note on what's ambiguous + what a human should look at>"}`,
  ].join("\n");
}

function repairSpecMarkdown(spec: { slug: string; title: string; owner: string; parent: string; intent: string; problem: string; target?: string }, signature: string, verdict: string, rootCause: string): string {
  return [
    `# ${spec.title} ⏳`,
    ``,
    `**Owner:** ${spec.owner || "[[../functions/platform]]"} · **Parent:** ${spec.parent || "extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]]"} · **Verdict:** ${verdict}`,
    `**Repair-root-cause:** \`${rootCause}\``,
    `**Repair-signature:** \`${signature}\``,
    ``,
    spec.intent.trim(),
    ``,
    `## Problem (from Control Tower signature \`${signature}\`)`,
    spec.problem.trim(),
    spec.target ? `\n**Likely target:** \`${spec.target}\`` : ``,
    ``,
    `## Phase 1 — close it ⏳`,
    `Scope from the problem above; land the fix + its brain page; gate on \`npx tsc --noEmit\`.`,
    ``,
    `## Verification`,
    `- Re-trigger the originating condition (signature \`${signature}\`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.`,
    ``,
    `> Authored by the box Repair Agent from Control Tower signature \`${signature}\` (verdict: ${verdict}). Commission the build from the Control Tower / Roadmap board.`,
    ``,
  ].join("\n");
}

interface RepairSpecProposal { slug: string; title: string; owner?: string; parent?: string; intent?: string; problem?: string; target?: string }

// Build-job statuses that mean a build for a slug is still live (mirror of src/lib/agent-jobs
// ACTIVE_STATUSES; inlined so the worker never loads that module at startup just for the array).
const ACTIVE_BUILD_STATUSES = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume"];

interface RepairLedgerEntry { jobId: string; signature: string; rootCause: string | null; authoredSlug: string | null; status: string; createdAt: string }

// The dedup LEDGER (repair-agent-dedup Phase 1): recent repair jobs + the root-cause key / authored
// spec slug each persisted onto its own `instructions` JSON. Backs root-cause grouping (sibling spec
// for the same cause → group, don't re-author) and the already-fixed skip (this signature was already
// addressed → resolve pending-deploy, don't re-diagnose). One small query, parsed in JS.
async function repairLedger(windowMs: number): Promise<RepairLedgerEntry[]> {
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  const { data } = await db
    .from("agent_jobs")
    .select("id, spec_slug, instructions, status, created_at")
    .eq("kind", "repair")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    let rootCause: string | null = null;
    let authoredSlug: string | null = null;
    try {
      const i = JSON.parse(String(r.instructions || "{}")) as { root_cause?: string; authored_slug?: string };
      rootCause = i.root_cause ?? null;
      authoredSlug = i.authored_slug ?? null;
    } catch { /* not JSON — no ledger fields */ }
    return { jobId: String(r.id), signature: String(r.spec_slug || ""), rootCause, authoredSlug, status: String(r.status || ""), createdAt: String(r.created_at || "") };
  });
}

// Is a build for this spec slug already live (active build job OR an open claude/<slug>-* PR)? The
// auto-build dedup guard — never enqueue a second build / open a 4th identical PR for one spec slug.
async function hasActiveBuildForSlug(slug: string): Promise<{ active: boolean; reason?: string }> {
  const { data: job } = await db
    .from("agent_jobs")
    .select("id")
    .eq("kind", "build")
    .eq("spec_slug", slug)
    .in("status", ACTIVE_BUILD_STATUSES)
    .limit(1)
    .maybeSingle();
  if (job) return { active: true, reason: "active build job" };
  try {
    const owner = REPO.split("/")[0];
    const open = await gh("GET", `/repos/${REPO}/pulls?state=open&per_page=100`);
    if (open.ok && Array.isArray(open.json)) {
      const prefix = `claude/${slug}-`;
      const hit = (open.json as Array<{ head?: { ref?: string }; number?: number }>).find(
        (p) => typeof p.head?.ref === "string" && (p.head.ref === `claude/${slug}` || p.head.ref.startsWith(prefix)),
      );
      if (hit) return { active: true, reason: `open PR #${hit.number}` };
    }
  } catch { /* PR list degraded — fall back to the job check above */ }
  return { active: false };
}

// Fetch + parse a repair-authored spec from main: its Repair-root-cause key, the signatures it
// already carries, plus the raw body + blob sha (so a grouping append can edit it in place).
async function fetchRepairSpec(slug: string): Promise<{ body: string; sha: string; rootCause: string | null; signatures: string[] } | null> {
  const { parseRepairSpecMeta } = await import("../src/lib/repair-agent");
  const get = await gh("GET", `/repos/${REPO}/contents/docs/brain/specs/${slug}.md?ref=main`);
  if (!get.ok) return null;
  const j = get.json as { content?: string; sha?: string };
  const body = Buffer.from(String(j.content || "").replace(/\s/g, ""), "base64").toString("utf8");
  const meta = parseRepairSpecMeta(body);
  return { body, sha: String(j.sha || ""), rootCause: meta.rootCause, signatures: meta.signatures };
}

// Append a `Repair-signature:` line to an existing repair spec (root-cause grouping: one spec carries
// N sibling signatures). No-op if it already carries this signature. Returns true on write.
async function appendSignatureToSpec(slug: string, body: string, sha: string, signature: string): Promise<boolean> {
  if (body.includes(`**Repair-signature:** \`${signature}\``)) return true; // already carried
  const line = `**Repair-signature:** \`${signature}\``;
  let next: string;
  const lines = body.split("\n");
  // insert right after the LAST existing Repair-signature line, else after the Repair-root-cause line.
  let idx = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("**Repair-signature:**") || lines[i].startsWith("**Repair-root-cause:**")) idx = i;
  if (idx >= 0) {
    lines.splice(idx + 1, 0, line);
    next = lines.join("\n");
  } else {
    next = `${body.trimEnd()}\n\n${line}\n`;
  }
  const put = await gh("PUT", `/repos/${REPO}/contents/docs/brain/specs/${slug}.md`, {
    message: `spec: ${slug} — group sibling Control Tower signature ${signature} (repair-agent dedup)`,
    content: Buffer.from(next, "utf8").toString("base64"),
    sha,
    branch: "main",
  });
  return put.ok;
}

// Author OR GROUP the fix spec on main (repair-agent-dedup Phase 1).
//   1. Root-cause grouping — if a sibling repair spec authored in this window covers the SAME
//      root-cause key (implicated file + failure mode), add THIS signature to it and reuse its slug
//      (one root cause → one spec, N signatures) rather than authoring a new spec.
//   2. Else author a new spec, stamping the Repair-root-cause key for future grouping.
// Same-slug convergence stays idempotent (a recurring failure folds onto one spec). Returns the
// resolved slug + whether it pre-existed + whether this was a group-onto-sibling, or null on failure.
async function groupOrAuthorRepairSpec(raw: unknown, signature: string, verdict: string): Promise<{ slug: string; alreadyExists: boolean; grouped: boolean; rootCause: string } | null> {
  const { rootCauseKey, REPAIR_RECENT_FIX_WINDOW_MS } = await import("../src/lib/repair-agent");
  const s = (raw || {}) as RepairSpecProposal;
  const rawSlug = String(s.slug || "");
  const title = String(s.title || "");
  if (!rawSlug || !title) return null;
  const slug = rawSlug.replace(/[^a-z0-9-]/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 60);
  if (!slug) return null;
  const rootCause = rootCauseKey(typeof s.target === "string" ? s.target : "", verdict);
  const path = `docs/brain/specs/${slug}.md`;
  try {
    // 1) Root-cause grouping: a sibling spec authored this cycle for the same cause → add this
    //    signature to IT (skip authoring a near-duplicate). Skip if rootCause is unknown (`?::…`).
    if (!rootCause.startsWith("?::")) {
      const ledger = await repairLedger(REPAIR_RECENT_FIX_WINDOW_MS);
      const sibling = ledger.find((e) => e.rootCause === rootCause && e.authoredSlug && e.authoredSlug !== slug && e.signature !== signature);
      if (sibling?.authoredSlug) {
        const spec = await fetchRepairSpec(sibling.authoredSlug);
        if (spec) {
          await appendSignatureToSpec(sibling.authoredSlug, spec.body, spec.sha, signature);
          return { slug: sibling.authoredSlug, alreadyExists: true, grouped: true, rootCause };
        }
      }
    }

    // 2) Same-slug convergence / author-new.
    const existing = await fetchRepairSpec(slug);
    if (existing) {
      // The slug already exists — ensure it carries THIS signature (a recurring failure converges).
      await appendSignatureToSpec(slug, existing.body, existing.sha, signature);
      return { slug, alreadyExists: true, grouped: false, rootCause };
    }
    const put = await putFileMain(
      path,
      repairSpecMarkdown(
        {
          slug,
          title,
          owner: String(s.owner || "[[../functions/platform]]"),
          parent: String(s.parent || "extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]]"),
          intent: String(s.intent || "Close the issue behind this Control Tower signature."),
          problem: String(s.problem || "(see the repair diagnosis above)"),
          target: typeof s.target === "string" ? s.target : undefined,
        },
        signature,
        verdict,
        rootCause,
      ),
      `spec: ${slug} (from Control Tower signature ${signature} via repair-agent ${verdict})`,
    );
    return put.ok ? { slug, alreadyExists: false, grouped: false, rootCause } : null;
  } catch (e) {
    console.warn(`[repair] spec commit failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// Already-fixed skip (repair-agent-dedup Phase 1): was THIS signature already addressed by a prior
// repair that authored a fix spec recently (whose build is in-flight or merged-but-not-yet-deployed)?
// The 2026-06-22 stale-error trap: an error recorded BEFORE its fix deployed must not re-trigger a
// fresh diagnosis. Returns the addressing spec slug if so (→ resolve "fixed by [[slug]], pending
// deploy", author nothing). The enqueue dedup only blocks LIVE same-signature jobs, so a re-fire
// after the prior repair COMPLETED slips through to here.
async function findAlreadyAddressing(signature: string, selfJobId: string): Promise<{ slug: string } | null> {
  const { REPAIR_RECENT_FIX_WINDOW_MS } = await import("../src/lib/repair-agent");
  const ledger = await repairLedger(REPAIR_RECENT_FIX_WINDOW_MS);
  const prior = ledger.find((e) => e.jobId !== selfJobId && e.signature === signature && e.authoredSlug);
  if (prior?.authoredSlug) return { slug: prior.authoredSlug };
  return null;
}

// Resolve the originating error_events row (transient no-op / owner Dismiss) so the panel clears.
async function resolveRepairErrorRow(instr: { source?: string; signature?: string; error_event_id?: string | null }): Promise<void> {
  if (instr.source === "loop-alert") return; // loop_alerts auto-resolve on recovery in the monitor.
  try {
    const patch = { status: "resolved", updated_at: new Date().toISOString() } as Record<string, unknown>;
    if (instr.error_event_id) await db.from("error_events").update(patch).eq("id", instr.error_event_id);
    else if (instr.signature) await db.from("error_events").update(patch).eq("signature", instr.signature);
  } catch (e) {
    console.warn(`[repair] resolve error row failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runRepairJob(job: Job) {
  const tag = `[repair:${job.id.slice(0, 8)}]`;
  let instr: { source?: string; signature?: string; title?: string; error_event_id?: string | null; loop_alert_id?: string | null } = {};
  try {
    instr = job.instructions ? JSON.parse(job.instructions) : {};
  } catch {
    /* not JSON — fall back to spec_slug as the signature */
  }
  const signature = instr.signature || job.spec_slug;
  instr.signature = signature;

  // ── Owner action resume — the surfaced repair_build was approved (Build) or declined (Dismiss). ──
  const buildAction = (job.pending_actions || []).find((a) => a.type === "repair_build");
  if (buildAction && (buildAction.status === "approved" || buildAction.status === "declined")) {
    if (buildAction.status === "approved" && buildAction.spec_slug) {
      // Auto-build dedup: never enqueue a second build for a slug that already has one in-flight /
      // an open PR (the 4-identical-PRs failure). If one's already live, settle this action onto it.
      const dupe = await hasActiveBuildForSlug(buildAction.spec_slug);
      if (dupe.active) {
        buildAction.status = "done";
        buildAction.result = `build already live for ${buildAction.spec_slug} (${dupe.reason}) — not re-queued`;
        await update(job.id, { status: "completed", pending_actions: job.pending_actions, log_tail: `owner Build → ${buildAction.result}`.slice(-2000) });
        console.log(`${tag} owner Build → dedup: ${buildAction.result}`);
        return;
      }
      // Queue the actual feature build for the authored fix spec (owner-gated — this is the gate).
      const { error } = await db.from("agent_jobs").insert({
        workspace_id: job.workspace_id,
        spec_slug: buildAction.spec_slug,
        kind: "build",
        status: "queued",
        created_by: job.created_by,
        instructions: `Build from Control Tower repair signature ${signature}. Follow the spec exactly; tsc-clean; open a PR.`,
      });
      buildAction.status = error ? "failed" : "done";
      buildAction.result = error ? `build enqueue failed: ${error.message}` : `queued build for ${buildAction.spec_slug}`;
      await update(job.id, { status: "completed", pending_actions: job.pending_actions, log_tail: `owner Build → ${buildAction.result}`.slice(-2000) });
      console.log(`${tag} owner Build → ${buildAction.result}`);
    } else {
      // Dismiss — clear the surfaced item; resolve the originating error row.
      await resolveRepairErrorRow(instr);
      buildAction.result = "dismissed by owner";
      await update(job.id, { status: "completed", pending_actions: job.pending_actions, log_tail: `owner Dismiss → resolved signature ${signature}`.slice(-2000) });
      console.log(`${tag} owner Dismiss → resolved`);
    }
    return;
  }

  // ── Already-fixed skip (repair-agent-dedup) — don't re-diagnose a problem whose fix already
  // shipped / is in-flight. A prior repair that authored a spec for THIS signature means it's
  // addressed (the stale-error trap: an error recorded BEFORE its fix deployed re-firing). The
  // enqueue dedup only blocks LIVE same-signature jobs, so a re-fire after the prior COMPLETED lands
  // here. Resolve "fixed by [[spec]], pending deploy" + author nothing. (Skip for the cluster job.) ──
  if (instr.source !== "cluster") {
    const addressed = await findAlreadyAddressing(signature, job.id);
    if (addressed) {
      await resolveRepairErrorRow(instr);
      await update(job.id, {
        status: "completed",
        error: null,
        log_tail: `already-fixed → resolved signature ${signature}: fixed by [[${addressed.slug}]], pending deploy (no re-diagnosis)`.slice(-2000),
      });
      console.log(`${tag} already-fixed by ${addressed.slug} → resolved, no diagnosis`);
      return;
    }
  }

  // ── Fresh diagnosis — investigate read-only on Max → classify → act. ──
  console.log(`${tag} diagnosing signature ${signature}`);
  try {
    const brief = await loadRepairBrief(instr);
    const { session, resultText, isError, raw } = await runRepairClaude(repairPrompt(brief), null, REPO_DIR);
    if (session) await update(job.id, { claude_session_id: session });
    const parsed = extractJson<Record<string, unknown>>(resultText);
    const verdict = String(parsed?.status || "");
    console.log(`${tag} claude finished — verdict: ${verdict || "(none)"} isError=${isError}`);

    if (verdict === "transient") {
      const reason = String(parsed?.reason || "transient / genuine wait — no code fix");
      await resolveRepairErrorRow(instr);
      await update(job.id, { status: "completed", error: null, log_tail: `transient → resolved: ${reason}`.slice(-2000) });
      console.log(`${tag} transient → resolved the error row, no spec`);
      return;
    }

    if (verdict === "needs-human") {
      const diagnosis = String(parsed?.diagnosis || "needs a human — couldn't confidently diagnose");
      // Surface for a human (no spec, no loop): needs_attention is read by the Control Tower repair feed.
      await update(job.id, { status: "needs_attention", error: "needs-human", log_tail: diagnosis.slice(-2000) });
      console.log(`${tag} needs-human → surfaced, no spec`);
      return;
    }

    if (verdict === "real-bug" || verdict === "monitor-false-positive" || verdict === "foreign-app-noise") {
      const diagnosis = String(parsed?.diagnosis || "");
      // Author OR GROUP: a sibling spec for the same root cause (implicated file + failure mode) →
      // add this signature to it, don't author a near-duplicate (one root cause → one spec).
      const authored = await groupOrAuthorRepairSpec(parsed?.spec, signature, verdict);
      if (!authored) {
        // Verdict reached but no valid spec landed → surface for a human rather than silently dropping it.
        await update(job.id, { status: "needs_attention", error: "no valid fix spec proposed", log_tail: diagnosis.slice(-2000) || "no valid fix spec" });
        console.log(`${tag} ${verdict} but no valid spec → surfaced needs-human`);
        return;
      }
      // Persist this signature's root-cause key + authored slug onto the job — the dedup ledger the
      // NEXT repair reads for root-cause grouping + the already-fixed skip.
      instr.signature = signature;
      const ledgerInstr = JSON.stringify({ ...instr, root_cause: authored.rootCause, authored_slug: authored.slug });
      const groupedNote = authored.grouped ? ` (grouped onto sibling for root cause ${authored.rootCause})` : authored.alreadyExists ? " (existing)" : "";

      // Narrow auto-queue allow-list (the ONE sanctioned auto path): a known-safe, mechanical,
      // monitor-only class auto-queues its build. Anything touching product code (real-bug) is
      // surfaced for one-tap owner Build instead (surface-don't-auto-build — the North star guard).
      const { isRepairAutobuildKind, REPAIR_AUTOBUILD_KINDS } = await import("../src/lib/repair-agent");
      if (isRepairAutobuildKind(verdict)) {
        const reason = REPAIR_AUTOBUILD_KINDS[verdict as keyof typeof REPAIR_AUTOBUILD_KINDS];
        // Auto-build dedup: ≤1 build per slug. If a build for this slug is already live / has an open
        // PR (a sibling job grouped onto the same spec, or a prior cycle), do NOT enqueue a second.
        const dupe = await hasActiveBuildForSlug(authored.slug);
        let buildResult: string;
        if (dupe.active) {
          buildResult = `build already live (${dupe.reason}) — not re-queued`;
        } else {
          const { error } = await db.from("agent_jobs").insert({
            workspace_id: job.workspace_id,
            spec_slug: authored.slug,
            kind: "build",
            status: "queued",
            instructions: `Auto-queued by repair-agent (${verdict} — ${reason}). Build from Control Tower signature ${signature}. Follow the spec exactly; tsc-clean; open a PR.`,
          });
          buildResult = error ? `auto-queue FAILED: ${error.message}` : "auto-queued build";
        }
        await update(job.id, {
          status: "completed",
          error: null,
          instructions: ledgerInstr,
          log_tail: `${verdict} (allow-listed: ${reason}) → authored ${authored.slug}${groupedNote} + ${buildResult}\n\n${diagnosis}`.slice(-2000),
        });
        console.log(`${tag} ${verdict} → authored ${authored.slug}${groupedNote} + ${buildResult}`);
        return;
      }

      // DEFAULT (real-bug, or any non-allow-listed verdict): surface the proposed fix for owner Build.
      const action: PendingAction = {
        id: `rp${job.id.slice(0, 6)}`,
        type: "repair_build",
        summary: `Fix ${signature} → build [[${authored.slug}]]`,
        preview: diagnosis.slice(0, 400),
        status: "pending",
        spec_slug: authored.slug,
      };
      await update(job.id, {
        status: "needs_approval",
        pending_actions: [action],
        instructions: ledgerInstr,
        log_tail: `${verdict} → authored fix spec ${authored.slug}${groupedNote}; surfaced for owner Build.\n\n${diagnosis}`.slice(-2000),
      });
      console.log(`${tag} ${verdict} → authored ${authored.slug}${groupedNote}, surfaced for owner Build`);
      return;
    }

    if (isError && !parsed) {
      await update(job.id, { status: "failed", error: "repair run errored", log_tail: raw.slice(-2000) });
      return;
    }
    // No recognizable verdict — surface rather than assume resolved.
    await update(job.id, { status: "needs_attention", error: "repair ended without a recognizable verdict", log_tail: raw.slice(-2000) });
  } catch (e) {
    await update(job.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    console.error(`${tag} failed:`, e instanceof Error ? e.message : e);
  }
}

// ── Box-hosted Regression Agent (regression-agent) ───────────────────────────
// A kind='regression' job is fired EVENT-driven the moment the box's spec-test agent records a
// regression on a shipped spec (inline at the end of runSpecTestJob — a ✅ verification that no longer
// holds). Like repair it runs a TOP-LEVEL `claude -p` on Max (no ANTHROPIC_API_KEY, web search on),
// KEEPS read-only prod, NEVER mutates product code. It REVIEWS the regression read-only → either
// DISMISSES it (transient/foreign/false-positive/already-fixed, recorded reasoning) or AUTHORS the fix
// spec DIRECTLY to main (no "propose" step — a regression is a confirmed break) and routes it to the
// inbox for the DevOps Director to queue (auto-approve within its leash; until the director is live the
// fix routes to the CEO). Loop-guard: a fix that fails to hold after REGRESSION_LOOP_GUARD_MAX authored
// attempts escalates to CEO. Every detect/dismiss/author/escalate writes a director_activity row.

async function runRegressionClaude(prompt: string, sessionId: string | null, cwd: string) {
  // Same env discipline as repair: KEEP read-only prod creds so the box can trace what regressed; strip
  // ONLY the API key so all LLM is Max-billed; web search stays on (investigation).
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const base = sessionId ? ["--resume", sessionId] : [];
  const args = [...base, "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json"];
  const r = await shAsync("claude", args, { cwd, env, timeout: REGRESSION_TIMEOUT_MS });
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

interface RegressionBriefInstr {
  signature?: string;
  spec_slug?: string;
  title?: string;
  failing?: Array<{ text: string; evidence?: string; check_key: string }>;
  run_at?: string;
}

// Load the read-only brief: the regressed spec slug, its failing `## Verification` checks (with the
// evidence the spec-test agent captured), and a pointer to read the spec + trace what shipped.
function regressionBrief(instr: RegressionBriefInstr): string {
  const lines: string[] = [
    `REGRESSED SPEC: docs/brain/specs/${instr.spec_slug}.md  (title: ${instr.title})`,
    `SIGNATURE: ${instr.signature}  ·  spec-test run_at: ${instr.run_at}`,
    ``,
    `This spec is ✅ SHIPPED but its verification no longer holds — the box spec-test agent observed these check(s) FAILING (evidence-backed breakage of prior-working behaviour):`,
  ];
  for (const f of instr.failing || []) {
    lines.push(`  ✗ ${f.text}`);
    if (f.evidence) lines.push(`      evidence: ${String(f.evidence).slice(0, 600)}`);
  }
  lines.push(
    ``,
    `Read docs/brain/specs/${instr.spec_slug}.md (esp. its "## Verification"), then trace what shipped that broke it (recent merges / the implicated src/ code) to decide whether this is a REAL regression and what the fix is.`,
  );
  return lines.join("\n");
}

function regressionPrompt(brief: string): string {
  return [
    `You are the box's Regression Agent on Max (web search on, no API key). You KEEP read access to prod, but you NEVER mutate and NEVER edit product code in this pass: you REVIEW a regression read-only (a ✅-shipped spec whose verification now fails), trace what regressed in the working tree (cwd is the repo root — read docs/brain/ first, then src/), and either DISMISS it or AUTHOR a fix spec (a doc). The actual code build is queued later by the DevOps Director — not now.`,
    `You do EXACTLY what the operator did by hand: review each regression and either dismiss it or author a fix spec. A regression is a confirmed break of PRIOR-WORKING behaviour — so unlike the repair agent you SKIP the "propose" step and author the fix spec DIRECTLY when it's real.`,
    ``,
    brief,
    ``,
    `Decide ONE verdict (cite what regressed + the offending change):`,
    `  • "real-regression" — a genuine break of prior-working behaviour traceable to a change we shipped. Author a single-phase, ~30-min-scoped fix spec that RESTORES it (what regressed, the offending change, the fix, and verification that the ORIGINAL ✅ holds again).`,
    `  • "transient" — a deploy-boundary race / momentary upstream blip that already recovered; NOT a real regression. Dismiss with the reason.`,
    `  • "foreign" — the failing check is foreign noise (a not-ours / flaky external dependency), not a regression of OUR behaviour. Dismiss with the reason.`,
    `  • "false-positive" — the spec-test CHECK itself mis-fired (the feature is actually fine — the bullet is mis-scoped / the probe was wrong). Dismiss with the reason.`,
    `  • "already-fixed" — a fix already shipped or is in-flight (pending deploy / re-test); no new spec needed. Dismiss with the reason.`,
    `  • "needs-human" — you CANNOT confidently review it (ambiguous, needs context only a human has). No spec, no guess — surface it with a plain one-line note.`,
    ``,
    `NEGATIVE GUARD — only a regression of PRIOR-WORKING behaviour belongs to you. A brand-new feature error (never worked) is the repair agent's, not yours — if that's what this is, return "false-positive" with that reason (it'll be left to the repair agent).`,
    ``,
    `For "real-regression", default owner "[[../functions/platform]]" and parent "extends [[../specs/regression-agent]]" unless a more specific function clearly owns the regressed system. The fix spec MUST be a SINGLE phase scoped to a ~30-min build. Provide the verification bullets that must hold again (reuse the regressed spec's failing checks).`,
    ``,
    `Final message = ONLY one JSON object:`,
    `  {"status":"real-regression","review":"<plain text: what regressed + the offending change + the fix>","spec":{"slug":"<stable-kebab-slug>","title":"...","owner":"[[../functions/platform]]","parent":"extends [[../specs/regression-agent]]","intent":"<one paragraph>","what_regressed":"<the ✅ behaviour that broke>","offending_change":"<the change/merge that broke it>","fix":"<what to change to restore it>","verification":["<bullet that must hold again>","..."]}}`,
    `  {"status":"transient"|"foreign"|"false-positive"|"already-fixed","reason":"<why this is not a real regression to fix>"}`,
    `  {"status":"needs-human","review":"<ONE-LINE plain note on what's ambiguous + what a human should look at>"}`,
  ].join("\n");
}

interface RegressionFixProposal {
  slug: string;
  title: string;
  owner?: string;
  parent?: string;
  intent?: string;
  what_regressed?: string;
  offending_change?: string;
  fix?: string;
  verification?: string[];
}

function regressionFixSpecMarkdown(spec: RegressionFixProposal, regressedSlug: string, signature: string): string {
  const verification = (Array.isArray(spec.verification) ? spec.verification : []).filter((b) => typeof b === "string" && b.trim());
  const vBullets = verification.length
    ? verification.map((b) => `- ${b.trim()}`).join("\n")
    : `- Re-run spec-test on [[${regressedSlug}]] → expect the previously-failing check(s) pass again.`;
  return [
    `# ${spec.title} ⏳`,
    ``,
    `**Owner:** ${spec.owner || "[[../functions/platform]]"} · **Parent:** ${spec.parent || "extends [[../specs/regression-agent]]"} · **Regression-of:** [[${regressedSlug}]]`,
    `**Regression-signature:** \`${signature}\``,
    ``,
    (spec.intent || "Restore the prior-working behaviour that regressed.").trim(),
    ``,
    `## What regressed`,
    (spec.what_regressed || "(see the regression review above)").trim(),
    ``,
    `## Offending change`,
    (spec.offending_change || "(unknown — bisect the recent ships that touched the implicated code)").trim(),
    ``,
    `## Phase 1 — restore it ⏳`,
    (spec.fix || "Scope from the diagnosis above; land the fix + its brain page.").trim(),
    `Gate on \`npx tsc --noEmit\`.`,
    ``,
    `## Verification`,
    vBullets,
    `- Re-run spec-test on [[${regressedSlug}]] → expect its previously-failing verification check(s) pass again (the original ✅ holds).`,
    ``,
    `> Authored by the box Regression Agent — a confirmed regression of [[${regressedSlug}]] (signature \`${signature}\`). The DevOps Director queues the build (auto-approve within its leash; pre-M4 the CEO queues it).`,
    ``,
  ].join("\n");
}

// Author the fix spec on main DIRECTLY (regression-agent: no "propose" step — a confirmed break). Slugs
// like repair; same-slug convergence stays idempotent (a recurring regression folds onto one spec).
// Returns the resolved slug + whether it pre-existed, or null on failure.
async function authorRegressionFixSpec(raw: unknown, regressedSlug: string, signature: string): Promise<{ slug: string; alreadyExists: boolean } | null> {
  const s = (raw || {}) as RegressionFixProposal;
  const rawSlug = String(s.slug || "");
  const title = String(s.title || "");
  if (!rawSlug || !title) return null;
  const slug = rawSlug.replace(/[^a-z0-9-]/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 60);
  if (!slug) return null;
  const path = `docs/brain/specs/${slug}.md`;
  try {
    const existing = await gh("GET", `/repos/${REPO}/contents/${path}?ref=main`);
    if (existing.ok) return { slug, alreadyExists: true }; // same-slug convergence — don't clobber.
    const put = await putFileMain(
      path,
      regressionFixSpecMarkdown({ ...s, slug, title }, regressedSlug, signature),
      `spec: ${slug} — fix regression of ${regressedSlug} (regression-agent, signature ${signature})`,
    );
    return put.ok ? { slug, alreadyExists: false } : null;
  } catch (e) {
    console.warn(`[regression] spec commit failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// Already-fixed skip (regression-agent): is a prior authored regression fix for THIS spec still
// in-flight (build queued / PR open / not yet deployed)? If so the daily spec-test re-fire is "pending
// deploy", not a fresh regression — no-op it (don't re-review, don't count toward the loop-guard).
// Returns the in-flight fix slug if so. Mirrors the repair-agent already-fixed skip.
async function findInflightRegressionFix(specSlug: string, selfJobId: string): Promise<{ slug: string } | null> {
  const { REGRESSION_RECENT_WINDOW_MS } = await import("../src/lib/regression-agent");
  const sinceIso = new Date(Date.now() - REGRESSION_RECENT_WINDOW_MS).toISOString();
  const { data } = await db
    .from("agent_jobs")
    .select("id, instructions")
    .eq("kind", "regression")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false });
  const slugs = new Set<string>();
  for (const r of (data ?? []) as Array<{ id: string; instructions?: string }>) {
    if (r.id === selfJobId) continue;
    try {
      const i = JSON.parse(String(r.instructions || "{}")) as { spec_slug?: string; authored_slug?: string };
      if (i.spec_slug === specSlug && i.authored_slug) slugs.add(i.authored_slug);
    } catch {
      /* not JSON — skip */
    }
  }
  for (const slug of slugs) {
    const a = await hasActiveBuildForSlug(slug);
    if (a.active) return { slug };
  }
  return null;
}

async function runRegressionJob(job: Job) {
  const tag = `[regression:${job.id.slice(0, 8)}]`;
  const { recordDirectorActivity } = await import("../src/lib/director-activity");
  const { regressionAuthoredAttempts, REGRESSION_LOOP_GUARD_MAX, REGRESSION_DISMISS_VERDICTS, REGRESSION_DIRECTOR_FUNCTION } = await import("../src/lib/regression-agent");
  let instr: RegressionBriefInstr & { authored_slug?: string; verdict?: string } = {};
  try {
    instr = job.instructions ? JSON.parse(job.instructions) : {};
  } catch {
    /* not JSON — degrade to the signature on spec_slug */
  }
  const signature = instr.signature || job.spec_slug;
  const regressedSlug = instr.spec_slug || "";

  // ── Disposer action resume — the routed regression_build was approved (queue) or declined (dismiss). ──
  const buildAction = (job.pending_actions || []).find((a) => a.type === "regression_build");
  if (buildAction && (buildAction.status === "approved" || buildAction.status === "declined")) {
    if (buildAction.status === "approved" && buildAction.spec_slug) {
      const dupe = await hasActiveBuildForSlug(buildAction.spec_slug);
      if (dupe.active) {
        buildAction.status = "done";
        buildAction.result = `build already live for ${buildAction.spec_slug} (${dupe.reason}) — not re-queued`;
        await update(job.id, { status: "completed", pending_actions: job.pending_actions, log_tail: `queue Build → ${buildAction.result}`.slice(-2000) });
        console.log(`${tag} queue Build → dedup: ${buildAction.result}`);
        return;
      }
      const { error } = await db.from("agent_jobs").insert({
        workspace_id: job.workspace_id,
        spec_slug: buildAction.spec_slug,
        kind: "build",
        status: "queued",
        created_by: job.created_by,
        instructions: `Build the regression fix for ${regressedSlug} (signature ${signature}). Follow the spec exactly; tsc-clean; open a PR.`,
      });
      buildAction.status = error ? "failed" : "done";
      buildAction.result = error ? `build enqueue failed: ${error.message}` : `queued build for ${buildAction.spec_slug}`;
      await update(job.id, { status: "completed", pending_actions: job.pending_actions, log_tail: `queue Build → ${buildAction.result}`.slice(-2000) });
      console.log(`${tag} queue Build → ${buildAction.result}`);
    } else {
      buildAction.result = "declined by disposer";
      await update(job.id, { status: "completed", pending_actions: job.pending_actions, log_tail: `disposer declined the regression fix for ${regressedSlug}`.slice(-2000) });
      console.log(`${tag} disposer declined`);
    }
    return;
  }

  // ── Already-fixed skip — a prior authored fix for this spec is still building / pending deploy. The
  // daily spec-test re-fire is "pending deploy", not a fresh regression: no-op (don't re-review, don't
  // count toward the loop-guard). verdict 'already-fixed' is NOT a no-resurface block, so once the build
  // resolves the break can re-fire if the fix didn't hold. ──
  const inflight = await findInflightRegressionFix(regressedSlug, job.id);
  if (inflight) {
    const ledger = JSON.stringify({ ...instr, verdict: "already-fixed" });
    await recordDirectorActivity(db, {
      workspaceId: job.workspace_id,
      directorFunction: REGRESSION_DIRECTOR_FUNCTION,
      actionKind: "dismissed_regression",
      specSlug: regressedSlug,
      reason: `already-fixed: regression fix [[${inflight.slug}]] is in-flight (pending build/deploy) — no re-review.`,
      metadata: { signature, verdict: "already-fixed", fix_slug: inflight.slug, job_id: job.id },
    });
    await update(job.id, { status: "completed", error: null, instructions: ledger, log_tail: `already-fixed → [[${inflight.slug}]] in-flight, pending deploy (no re-review)`.slice(-2000) });
    console.log(`${tag} already-fixed by in-flight ${inflight.slug} → no re-review`);
    return;
  }

  // ── Loop-guard — a regression fix that didn't hold after N authored attempts → escalate to CEO
  // (a deeper issue), never infinite re-author. (regression-agent Verification: 2 attempts → CEO.) ──
  const attempts = await regressionAuthoredAttempts(db, regressedSlug, job.id);
  if (attempts >= REGRESSION_LOOP_GUARD_MAX) {
    const note = `Loop-guard: ${attempts} prior authored fix(es) for ${regressedSlug} did not hold — this regression is a DEEPER issue. Escalated to CEO instead of re-authoring.`;
    await recordDirectorActivity(db, {
      workspaceId: job.workspace_id,
      directorFunction: REGRESSION_DIRECTOR_FUNCTION,
      actionKind: "escalated",
      specSlug: regressedSlug,
      reason: note,
      metadata: { signature, attempts, job_id: job.id },
    });
    await update(job.id, { status: "needs_attention", error: "regression loop-guard → escalated to CEO", log_tail: note.slice(-2000) });
    console.log(`${tag} loop-guard (${attempts} attempts) → escalated to CEO`);
    return;
  }

  // ── Fresh review — investigate read-only on Max → verdict → dismiss | author + route. ──
  console.log(`${tag} reviewing regression ${signature} (spec ${regressedSlug})`);
  try {
    const { session, resultText, isError, raw } = await runRegressionClaude(regressionPrompt(regressionBrief(instr)), null, REPO_DIR);
    if (session) await update(job.id, { claude_session_id: session });
    const parsed = extractJson<Record<string, unknown>>(resultText);
    const verdict = String(parsed?.status || "");
    console.log(`${tag} claude finished — verdict: ${verdict || "(none)"} isError=${isError}`);

    // DISMISS — transient / foreign / false-positive / already-fixed: recorded reasoning, no spec, no
    // re-surface (the signature's verdict on instructions blocks a future enqueue of the same break).
    if (REGRESSION_DISMISS_VERDICTS.has(verdict)) {
      const reason = String(parsed?.reason || `${verdict} — not a real regression to fix`);
      const ledger = JSON.stringify({ ...instr, verdict });
      await recordDirectorActivity(db, {
        workspaceId: job.workspace_id,
        directorFunction: REGRESSION_DIRECTOR_FUNCTION,
        actionKind: "dismissed_regression",
        specSlug: regressedSlug,
        reason: `Dismissed (${verdict}): ${reason}`,
        metadata: { signature, verdict, job_id: job.id },
      });
      await update(job.id, { status: "completed", error: null, instructions: ledger, log_tail: `dismissed (${verdict}): ${reason}`.slice(-2000) });
      console.log(`${tag} dismissed (${verdict}) → no spec, no re-surface`);
      return;
    }

    if (verdict === "needs-human") {
      const review = String(parsed?.review || "needs a human — couldn't confidently review the regression");
      await update(job.id, { status: "needs_attention", error: "needs-human", log_tail: review.slice(-2000) });
      console.log(`${tag} needs-human → surfaced, no spec`);
      return;
    }

    if (verdict === "real-regression") {
      const review = String(parsed?.review || "");
      const authored = await authorRegressionFixSpec(parsed?.spec, regressedSlug, signature);
      if (!authored) {
        await update(job.id, { status: "needs_attention", error: "no valid fix spec authored", log_tail: review.slice(-2000) || "real regression but no valid fix spec" });
        console.log(`${tag} real-regression but no valid spec → surfaced needs-human`);
        return;
      }
      const ledger = JSON.stringify({ ...instr, verdict, authored_slug: authored.slug });
      const existsNote = authored.alreadyExists ? " (existing slug — converged)" : "";

      // Route to the disposer. resolveApproverLive walks the org chart from 'platform' to the first
      // live+autonomous boss; a regression fix is low-risk/reversible so a live director auto-approves
      // it WITHIN its leash. Until the director is live this resolves to the CEO → surface for the
      // CEO inbox (regression-agent: "Until the director is live, the fix routes to the CEO inbox").
      let approver = "ceo";
      try {
        const { resolveApproverLive } = await import("../src/lib/agents/approval-router");
        approver = await resolveApproverLive(REGRESSION_DIRECTOR_FUNCTION);
      } catch (e) {
        console.warn(`${tag} approver resolve degraded → CEO: ${e instanceof Error ? e.message : String(e)}`);
      }
      const autoQueue = approver !== "ceo";

      if (autoQueue) {
        // The DevOps Director queues the build within its leash (auto-approve a reversible regression fix).
        const dupe = await hasActiveBuildForSlug(authored.slug);
        let buildResult: string;
        if (dupe.active) {
          buildResult = `build already live (${dupe.reason}) — not re-queued`;
        } else {
          const { error } = await db.from("agent_jobs").insert({
            workspace_id: job.workspace_id,
            spec_slug: authored.slug,
            kind: "build",
            status: "queued",
            instructions: `Auto-queued by the DevOps Director (${approver}) — regression fix for ${regressedSlug} (reversible/low-risk, within leash). Follow the spec exactly; tsc-clean; open a PR.`,
          });
          buildResult = error ? `auto-queue FAILED: ${error.message}` : "auto-queued build";
        }
        await recordDirectorActivity(db, {
          workspaceId: job.workspace_id,
          directorFunction: approver,
          actionKind: "authored_fix",
          specSlug: authored.slug,
          reason: `Real regression of ${regressedSlug} → authored fix [[${authored.slug}]]${existsNote}; ${approver} queued the build within its leash (${buildResult}).`,
          metadata: { signature, regressed: regressedSlug, fix_slug: authored.slug, approver, job_id: job.id },
        });
        await update(job.id, {
          status: "completed",
          error: null,
          instructions: ledger,
          log_tail: `real-regression → authored [[${authored.slug}]]${existsNote}; ${approver} auto-queued build (${buildResult}).\n\n${review}`.slice(-2000),
        });
        console.log(`${tag} real-regression → authored ${authored.slug}${existsNote}; ${approver} auto-queued (${buildResult})`);
        return;
      }

      // Pre-M4 (no live director): route to the CEO inbox — surface the authored fix for one-tap queue.
      await recordDirectorActivity(db, {
        workspaceId: job.workspace_id,
        directorFunction: REGRESSION_DIRECTOR_FUNCTION,
        actionKind: "authored_fix",
        specSlug: authored.slug,
        reason: `Real regression of ${regressedSlug} → authored fix [[${authored.slug}]]${existsNote}; routed to the CEO inbox to queue (no live director yet).`,
        metadata: { signature, regressed: regressedSlug, fix_slug: authored.slug, approver: "ceo", job_id: job.id },
      });
      const action: PendingAction = {
        id: `rg${job.id.slice(0, 6)}`,
        type: "regression_build",
        summary: `Regression fix for ${regressedSlug} → build [[${authored.slug}]]`,
        preview: review.slice(0, 400),
        status: "pending",
        spec_slug: authored.slug,
      };
      await update(job.id, {
        status: "needs_approval",
        pending_actions: [action],
        instructions: ledger,
        log_tail: `real-regression → authored fix spec ${authored.slug}${existsNote}; routed to the CEO inbox to queue the build.\n\n${review}`.slice(-2000),
      });
      console.log(`${tag} real-regression → authored ${authored.slug}${existsNote}, routed to CEO inbox`);
      return;
    }

    if (isError && !parsed) {
      await update(job.id, { status: "failed", error: "regression review errored", log_tail: raw.slice(-2000) });
      return;
    }
    await update(job.id, { status: "needs_attention", error: "regression review ended without a recognizable verdict", log_tail: raw.slice(-2000) });
  } catch (e) {
    await update(job.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    console.error(`${tag} failed:`, e instanceof Error ? e.message : e);
  }
}

// ── Box-hosted Storefront Optimizer agent (storefront-optimizer-agent) ───────
// A kind='storefront-optimizer' job is enqueued by the scheduling cron ([[storefront-optimizer]]
// → enqueueDueCampaigns) — one per DUE (product × lander-type × audience), deduped to ≤1 active
// campaign per surface. Like migration-fix/repair it runs a TOP-LEVEL `claude -p` on Max (no
// ANTHROPIC_API_KEY, keeps read-only DB secrets) that DIAGNOSES read-only and PROPOSES a typed plan:
//   • a reversible-lever campaign (copy/hero/chapter patch) → the worker stands up the M1 experiment
//     vs holdout (immediately if the policy auto-runs reversible levers, else surfaced for one-tap
//     owner Approve);
//   • a missing capability (a new component / a video hero / an offer or structural change — all
//     beyond a reversible content patch) → the worker authors a scoped spec to main + surfaces a
//     Build card (the repair-agent surface-don't-auto-build pattern), NEVER faking the lever.
// Phase 4 (decide → learn → report) is already wired in the M1 refresh (commitLearning → M2
// updatePosterior); the experiment row IS the campaign record M5 grades. spec_slug = the surface key
// `${product_id}:${lander_type}:${audience}`; instructions = JSON {workspace_id, product_id,
// lander_type, audience, lever_key, lever_reason}. No PR — it mutates the experiment tables, not the
// repo (except the missing-capability spec, committed to main like repair). See
// docs/brain/specs/storefront-optimizer-agent.md.
async function runStorefrontOptimizerClaude(prompt: string, sessionId: string | null, cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // stay on Max — never the Anthropic API
  const base = sessionId ? ["--resume", sessionId] : [];
  const args = [...base, "-p", prompt, "--dangerously-skip-permissions", "--output-format", "json"];
  const r = await shAsync("claude", args, { cwd, env, timeout: STOREFRONT_OPTIMIZER_TIMEOUT_MS });
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

interface OptimizerSurfaceLite { workspace_id: string; product_id: string; lander_type: string; audience: string; lever_key?: string; lever_reason?: string }

function storefrontOptimizerPrompt(brief: string, surface: OptimizerSurfaceLite): string {
  return [
    `You are the box's Storefront Optimizer agent on Max (read-only — web search on, no API key). Your boss is the Growth director; your objective is predicted-LTV-per-visitor + a rising average campaign grade. cwd is the repo root.`,
    `Run ONE campaign cycle for the surface below: read the state in the BRIEF, form ONE atomic, CRO-grounded hypothesis on ONE lever, and emit a typed plan. You DIAGNOSE + PROPOSE only — the worker stands up the experiment / authors the spec on the gate's verdict. NEVER mutate the DB yourself.`,
    ``,
    `SURFACE: product=${surface.product_id} · lander_type=${surface.lander_type} · audience=${surface.audience}`,
    ``,
    brief,
    ``,
    `CRO PRINCIPLES (ground the hypothesis in these): benefit/pain over features · hero dominant · pricing clarity is the #2 lever · message-match (ad → lander) · one clear CTA · no friction. Honor the brand voice + supplement-compliance HARD RAILS: NO disease claims, NO fabricated stats, NO unverifiable superlatives.`,
    ``,
    `Pick the lever: prefer the NEXT-BEST lever from the M2 map (or another ranked candidate if the funnel signal points elsewhere). ONE atomic lever per campaign — never bundle two changes. Surface your reasoning: cite BOTH the funnel signal AND the lever posterior the hypothesis came from.`,
    ``,
    `Classify the lever:`,
    `  • REVERSIBLE (copy / hero / chapter add-remove-reorder) → propose a "campaign". The variant is a reversible content patch, OR a generated hero (the worker generates it from your prompt). This is the ONLY auto-run-eligible class.`,
    `  • OFFER (pricing / discount / renewal-offer change) or STRUCTURAL (a NEW component, a new chapter TYPE, a video hero, a comparison-table widget — anything a reversible content patch can't express) → do NOT fake it as a content patch. Emit "needs_build": author a scoped single-phase spec (Owner: [[../functions/growth]] + a parent) so the worker commits it to main and surfaces a Build card for the owner. These are ALWAYS approval-gated.`,
    ``,
    `Variant patch shape (reversible content — applyVariantPatch in src/lib/storefront/experiments.ts): {headline?, dek?, publication?, sponsorLabel?, heroCaption?, heroImageUrl?, chapterHeading?, chapterParagraphs?:string[], chapterOrder?:number[], reasonsOrder?:number[]}. For a generated hero use kind:"hero" + hero_prompt (the worker calls Nano-Banana + uploads, then sets heroImageUrl).`,
    ``,
    `If the BRIEF says CONSERVATIVE (M3 uncalibrated): make a SMALLER bet — one modest, high-confidence change; the worker reserves a bigger holdout automatically.`,
    `If the activation GATE is idle/refused_scope: emit "idle" (do not propose). If there's no worthwhile lever to test: "idle". If a genuine product decision the brief doesn't cover blocks you: "needs_input" with ONE plain question.`,
    ``,
    `Final message = ONLY one JSON object:`,
    `  {"status":"propose","hypothesis":"<one testable sentence>","reasoning":"<cites the funnel signal + the lever posterior>","lever_key":"<one of the ranked candidate lever_keys>","lever_class":"reversible","lander_type":"${surface.lander_type}","audience":"${surface.audience}","holdout_pct":0.1,"variant":{"label":"<short>","kind":"content","patch":{...}}}`,
    `  {"status":"propose",...,"variant":{"label":"<short>","kind":"hero","hero_prompt":"<photoreal hero brief; composites the product pouch>"}}`,
    `  {"status":"needs_build","hypothesis":"<what you'd test if it existed>","spec":{"slug":"<stable kebab slug>","title":"...","owner":"[[../functions/growth]]","parent":"<a Growth mandate or goal milestone>","intent":"<one paragraph>","problem":"<concrete, grounded in the funnel + lever>","target":"src/lib/<the file/area>"}}`,
    `  {"status":"idle","reason":"<why nothing worthwhile to test now>"}`,
    `  {"status":"needs_input","questions":[{"id":"q1","q":"<ONE plain product question>"}]}`,
  ].join("\n");
}

// Author the missing-capability spec to main (Phase 5 build-or-request). Idempotent on a stable slug:
// if it already exists, leave it for the in-flight build rather than clobbering. Returns {slug, note}.
async function authorOptimizerSpec(raw: unknown, surface: OptimizerSurfaceLite): Promise<{ slug: string; note: string } | null> {
  const s = (raw || {}) as Record<string, unknown>;
  const rawSlug = String(s.slug || "");
  const title = String(s.title || "");
  if (!rawSlug || !title) return null;
  const slug = rawSlug.replace(/[^a-z0-9-]/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 60);
  if (!slug) return null;
  const path = `docs/brain/specs/${slug}.md`;
  const md = [
    `# ${title} ⏳`,
    ``,
    `**Owner:** ${String(s.owner || "[[../functions/growth]]")} · **Parent:** ${String(s.parent || "extends [[../specs/storefront-optimizer-agent]]")} · **Optimizer-surface:** \`${surface.product_id}:${surface.lander_type}:${surface.audience}\``,
    ``,
    String(s.intent || "Add the storefront capability the optimizer needs to test this lever.").trim(),
    ``,
    `## Problem (from a Storefront Optimizer hypothesis on \`${surface.lander_type}\`)`,
    String(s.problem || "(see the optimizer's reasoning below)").trim(),
    typeof s.target === "string" && s.target ? `\n**Likely target:** \`${s.target}\`` : ``,
    ``,
    `## Phase 1 — build the lever ⏳`,
    `Scope from the problem above; land the new component/lever + register it in [[../specs/storefront-lever-importance-memory|M2]]'s \`storefront_levers\`; add its brain page; gate on \`npx tsc --noEmit\`.`,
    ``,
    `## Verification`,
    `- Once shipped, the new lever appears in \`storefront_levers\` and the optimizer can pick it via \`nextLeverToTest\` for \`${surface.lander_type}\` → expect a campaign stands up on it.`,
    ``,
    `> Authored by the box Storefront Optimizer (build-or-request) for surface \`${surface.product_id}:${surface.lander_type}:${surface.audience}\`. Commission the build from the Roadmap board (owner = growth).`,
    ``,
  ].join("\n");
  try {
    const existing = await gh("GET", `/repos/${REPO}/contents/${path}?ref=main`);
    if (existing.ok) return { slug, note: `spec already tracked: ${path} (commission on Roadmap)` };
    const put = await putFileMain(path, md, `spec: ${slug} (from storefront-optimizer build-or-request)`);
    return put.ok ? { slug, note: `spec authored: ${path} (owner=growth) — commission on Roadmap` } : null;
  } catch (e) {
    console.warn(`[storefront-optimizer] spec commit failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function runStorefrontOptimizerJob(job: Job) {
  const tag = `[sf-opt:${job.id.slice(0, 8)}]`;
  let instr: OptimizerSurfaceLite = { workspace_id: job.workspace_id, product_id: "", lander_type: "", audience: "all" };
  try {
    if (job.instructions) instr = { ...instr, ...JSON.parse(job.instructions) };
  } catch {
    // Fall back to parsing the surface key out of spec_slug (`product:lander:audience`).
    const parts = (job.spec_slug || "").split(":");
    if (parts.length === 3) instr = { workspace_id: job.workspace_id, product_id: parts[0], lander_type: parts[1], audience: parts[2] };
  }
  const surface: OptimizerSurfaceLite = {
    workspace_id: instr.workspace_id || job.workspace_id,
    product_id: instr.product_id,
    lander_type: instr.lander_type,
    audience: instr.audience || "all",
    lever_key: instr.lever_key,
    lever_reason: instr.lever_reason,
  };
  if (!surface.product_id || !surface.lander_type) {
    await update(job.id, { status: "failed", error: "storefront-optimizer job missing product_id/lander_type" });
    return;
  }

  const opt = await import("../src/lib/storefront/optimizer-agent");
  const policyLib = await import("../src/lib/storefront/optimizer-policy");

  // ── Approval resume: the owner approved/declined a campaign, rejected a hero preview with notes,
  //    or approved/dismissed a missing-capability Build card. ──
  const isApprovalResume = (job.pending_actions || []).some(
    (a) => a.status === "approved" || a.status === "declined" || a.status === "reject_regen",
  );
  if (isApprovalResume) {
    const actions = (job.pending_actions || []).map((a) => ({ ...a }));
    const results: string[] = [];
    for (const act of actions) {
      if (act.type === "storefront_campaign") {
        if (act.status === "declined") { act.result = "declined by owner"; results.push("campaign → declined"); continue; }
        const plan = act.campaign_plan as Record<string, unknown> | undefined;
        const variant = (plan?.variant || {}) as Record<string, unknown>;
        const isHero = String(variant.kind) === "hero";

        // ── optimizer-hero-preview-gate: Reject-with-notes → regenerate a fresh candidate honoring the
        //    notes; keep the rejected attempt + its note on the campaign; re-surface for preview. Nothing
        //    serves to a shopper — the gen learns within the loop until the owner approves an image. ──
        if (act.status === "reject_regen") {
          if (!plan || !isHero) { act.status = "failed"; act.result = "reject_regen on a non-hero/empty campaign"; results.push("campaign → reject_regen invalid"); continue; }
          try {
            const attempts = Array.isArray(act.preview_attempts) ? [...act.preview_attempts] : [];
            if (act.preview_image_url) attempts.push({ url: act.preview_image_url, notes: act.reject_notes || "", at: new Date().toISOString() });
            const allNotes = attempts.map((a) => a.notes).filter((n): n is string => !!n && !!n.trim());
            const url = await regenerateOptimizerHero(opt, surface, plan, allNotes, attempts.length);
            if (!url) { act.status = "failed"; act.result = "regeneration failed (no isolated product image / Gemini error)"; results.push("campaign → regen failed"); continue; }
            act.preview_attempts = attempts;
            act.preview_image_url = url;
            act.reject_notes = undefined;
            act.stage = "preview";
            act.status = "pending"; // re-surface for image-approval (still nothing live)
            act.result = `regenerated candidate #${attempts.length + 1} from ${allNotes.length} note(s)`;
            results.push(`campaign → ${act.result} (re-surfaced for preview)`);
          } catch (e) {
            act.status = "failed"; act.result = e instanceof Error ? e.message : String(e);
            results.push(`campaign → regen errored: ${act.result}`);
          }
          continue;
        }

        if (act.status !== "approved") continue;
        try {
          if (!plan) { act.status = "failed"; act.result = "no campaign_plan on action"; results.push("campaign → failed (no plan)"); continue; }
          // Re-gate on approval (TOCTOU): the scope/active gate (evaluateProposalGate) only ran at PROPOSE
          // time. If the policy's `product_scope` shrank or `active` flipped false between propose and this
          // approval, the campaign must NOT still materialize — it would violate the "every activation
          // checks product_id ∈ product_scope" contract. Re-load the live policy and re-assert before
          // standing up the experiment (or even generating a preview); refuse (surface) if no longer active / in scope.
          const reAdmin = (await import("../src/lib/supabase/admin")).createAdminClient();
          const livePolicy = await policyLib.loadOptimizerPolicy(reAdmin, surface.workspace_id);
          if (!policyLib.isOptimizerActive(livePolicy)) {
            act.status = "failed";
            act.result = "refused on approval — optimizer is no longer active for this workspace (policy off/absent since propose); campaign NOT materialized";
            results.push(`campaign → refused (inactive): ${act.result}`);
            continue;
          }
          if (!policyLib.isProductInScope(livePolicy, surface.product_id)) {
            act.status = "failed";
            act.result = `refused on approval — product ${surface.product_id} is no longer in the optimizer product_scope (scope shrank since propose); campaign NOT materialized`;
            results.push(`campaign → refused (out of scope): ${act.result}`);
            continue;
          }

          // ── optimizer-hero-preview-gate: STAGE 1 — concept-approve of a HERO campaign. Generate the
          //    candidate hero (don't go live yet) and re-surface for image-approval. Only the final
          //    owner-approved image is ever served; nothing reaches live traffic on a prompt alone. ──
          if (isHero && act.stage !== "preview") {
            const url = await regenerateOptimizerHero(opt, surface, plan, [], 0);
            if (!url) { act.status = "failed"; act.result = "hero generation failed (no isolated product image / Gemini error)"; results.push("campaign → gen failed"); continue; }
            act.preview_image_url = url;
            act.preview_attempts = act.preview_attempts || [];
            act.stage = "preview";
            act.status = "pending"; // re-surface for image-approval (NOT live yet)
            act.result = "candidate hero generated — awaiting your image-approval (not live)";
            results.push("campaign → candidate generated, surfaced for image-approval (not live)");
            continue;
          }

          // ── STAGE 2 (image-approval of a hero) OR a content lever (no image to preview → skips the gate).
          //    Only an image-approval (or a content approve) calls materializeCampaign. ──
          const approvedHero = act.stage === "preview" ? act.preview_image_url : undefined;
          const r = await materializeOptimizerCampaign(opt, surface, plan, job.created_by, false, approvedHero);
          act.status = r.ok ? "done" : "failed";
          act.result = r.detail;
          results.push(`campaign → ${act.status}: ${r.detail}`);
        } catch (e) {
          act.status = "failed"; act.result = e instanceof Error ? e.message : String(e);
          results.push(`campaign → failed: ${act.result}`);
        }
      } else if (act.type === "storefront_build") {
        if (act.status === "declined") { act.result = "dismissed by owner"; results.push("build → dismissed"); continue; }
        if (act.status !== "approved" || !act.spec_slug) continue;
        const dupe = await hasActiveBuildForSlug(act.spec_slug);
        if (dupe.active) {
          act.status = "done"; act.result = `build already live for ${act.spec_slug} (${dupe.reason}) — not re-queued`;
        } else {
          const { error } = await db.from("agent_jobs").insert({
            workspace_id: job.workspace_id,
            spec_slug: act.spec_slug,
            kind: "build",
            status: "queued",
            created_by: job.created_by,
            instructions: `Build from storefront-optimizer missing-capability spec ${act.spec_slug}. Follow the spec exactly; tsc-clean; open a PR.`,
          });
          act.status = error ? "failed" : "done";
          act.result = error ? `build enqueue failed: ${error.message}` : `queued build for ${act.spec_slug}`;
        }
        results.push(`build → ${act.status}: ${act.result}`);
      }
    }
    // If any action was re-surfaced for the owner (a hero preview now awaits image-approval), the job
    // returns to needs_approval; otherwise it's terminal (completed). ≤1 action per optimizer job.
    const reSurfaced = actions.some((a) => a.status === "pending");
    await update(job.id, {
      status: reSurfaced ? "needs_approval" : "completed",
      pending_actions: actions,
      error: null,
      log_tail: (results.join("; ") || "no actions").slice(-2000),
    });
    console.log(`${tag} resume applied (${reSurfaced ? "re-surfaced for preview" : "terminal"}): ${results.join("; ")}`);
    return;
  }

  // ── Fresh diagnosis. Dedup first: ≤1 active campaign per surface. ──
  const admin = (await import("../src/lib/supabase/admin")).createAdminClient();
  if (await opt.hasActiveCampaignForSurface(admin, { workspace_id: surface.workspace_id, product_id: surface.product_id, lander_type: surface.lander_type as never, audience: surface.audience })) {
    await update(job.id, { status: "completed", error: null, log_tail: `a campaign is already active on ${opt.surfaceKey(surface)} — skipped (deduped)`.slice(-2000) });
    console.log(`${tag} deduped — active campaign already on ${opt.surfaceKey(surface)}`);
    return;
  }

  try {
    const brief = await opt.loadOptimizerBrief({ surface: { workspace_id: surface.workspace_id, product_id: surface.product_id, lander_type: surface.lander_type as never, audience: surface.audience } });
    // Gate: idle / refused_scope → don't propose at all.
    if (!brief.gate.canPropose) {
      await update(job.id, { status: "completed", error: null, log_tail: `not proposing — ${brief.gate.disposition}: ${brief.gate.reason}`.slice(-2000) });
      console.log(`${tag} ${brief.gate.disposition} — not proposing`);
      return;
    }

    const { session, resultText, isError, raw } = await runStorefrontOptimizerClaude(storefrontOptimizerPrompt(brief.text, surface), null, REPO_DIR);
    if (session) await update(job.id, { claude_session_id: session });
    const parsed = extractJson<Record<string, unknown>>(resultText);
    console.log(`${tag} claude finished — status: ${parsed?.status ?? "(none)"} isError=${isError}`);

    if (parsed?.status === "idle") {
      await update(job.id, { status: "completed", error: null, log_tail: `idle: ${String(parsed.reason || "no worthwhile lever to test")}`.slice(-2000) });
      return;
    }

    if (parsed?.status === "needs_input") {
      const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
      await update(job.id, { status: "needs_input", questions, log_tail: "awaiting a product decision".slice(-2000) });
      console.log(`${tag} needs_input — asked ${questions.length} question(s)`);
      return;
    }

    if (parsed?.status === "needs_build") {
      // Phase 5 — build-or-request. Author the scoped spec to main + surface a Build card (no auto-build).
      const authored = await authorOptimizerSpec(parsed.spec, surface);
      if (!authored) {
        await update(job.id, { status: "needs_attention", error: "no valid capability spec proposed", log_tail: String(parsed.hypothesis || "missing-capability, no spec").slice(-2000) });
        return;
      }
      const action: PendingAction = {
        id: `so${job.id.slice(0, 6)}`,
        type: "storefront_build",
        summary: `New storefront lever → build [[${authored.slug}]]`,
        preview: String(parsed.hypothesis || "").slice(0, 400),
        status: "pending",
        spec_slug: authored.slug,
      };
      await update(job.id, { status: "needs_approval", pending_actions: [action], log_tail: `needs_build → ${authored.note}; surfaced for owner Build.\n\n${String(parsed.hypothesis || "")}`.slice(-2000) });
      console.log(`${tag} needs_build → authored ${authored.slug}, surfaced for owner Build`);
      return;
    }

    if (parsed?.status === "propose") {
      // Validate the proposed lever is a known candidate + the class is reversible (the only campaign-able class).
      const leverKey = String(parsed.lever_key || "");
      const leverClass = String(parsed.lever_class || "reversible");
      const known = brief.candidates.some((c) => c.lever_key === leverKey);
      if (!leverKey || !known) {
        await update(job.id, { status: "needs_attention", error: `proposed unknown lever_key '${leverKey}'`, log_tail: `lever not in the ranked candidates — not standing up`.slice(-2000) });
        return;
      }
      if (leverClass !== "reversible") {
        await update(job.id, { status: "needs_attention", error: `proposed a ${leverClass} lever as a campaign`, log_tail: `offer/structural levers must be routed via needs_build, not a content campaign`.slice(-2000) });
        return;
      }

      // Re-gate on the actual (reversible) lever class.
      const gate = policyLib.evaluateProposalGate(brief.policy, { productId: surface.product_id, leverClass: "reversible" });
      const planForStore: Record<string, unknown> = { ...parsed };
      const hypothesis = String(parsed.hypothesis || "");

      if (gate.disposition === "auto_run") {
        // Reversible + auto_run_reversible — stand up the experiment immediately (no per-campaign tap).
        const r = await materializeOptimizerCampaign(opt, surface, planForStore, job.created_by, brief.conservative);
        if (!r.ok) { await update(job.id, { status: "needs_attention", error: "auto-run materialize failed", log_tail: r.detail.slice(-2000) }); return; }
        await update(job.id, { status: "completed", error: null, log_tail: `AUTO-RAN (reversible) — ${r.detail}\nhypothesis: ${hypothesis}`.slice(-2000) });
        console.log(`${tag} auto-ran campaign — ${r.detail}`);
        return;
      }

      // needs_approval — surface a campaign Approve card carrying the typed plan. For a HERO lever this is
      // the CONCEPT approve (stage 1 of the preview gate): approving generates a candidate hero, then the
      // owner sees the actual image and approves it live or rejects-with-notes (optimizer-hero-preview-gate).
      // A content lever has no image to preview, so it materializes on the first approve (no stage).
      const variantKind = String((parsed.variant as Record<string, unknown> | undefined)?.kind || "content");
      const action: PendingAction = {
        id: `so${job.id.slice(0, 6)}`,
        type: "storefront_campaign",
        summary: `Run campaign on ${opt.surfaceKey(surface)} — lever ${leverKey}`,
        preview: `${hypothesis}\n\n${String(parsed.reasoning || "")}`.slice(0, 400),
        status: "pending",
        campaign_plan: planForStore,
        ...(variantKind === "hero" ? { stage: "concept" as const } : {}),
      };
      await update(job.id, { status: "needs_approval", pending_actions: [action], log_tail: `proposed campaign (lever ${leverKey}) → awaiting owner Approve.\n\n${hypothesis}`.slice(-2000) });
      console.log(`${tag} proposed campaign on ${opt.surfaceKey(surface)} → awaiting approval`);
      return;
    }

    if (isError && !parsed) {
      await update(job.id, { status: "failed", error: "storefront-optimizer run errored", log_tail: raw.slice(-2000) });
      return;
    }
    await update(job.id, { status: "needs_attention", error: "storefront-optimizer ended without a recognizable status", log_tail: raw.slice(-2000) });
  } catch (e) {
    await update(job.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    console.error(`${tag} failed:`, e instanceof Error ? e.message : e);
  }
}

// Generate a candidate hero for the preview gate: composites the isolated pouch at the lander's real
// hero aspect, augmenting the prompt with the owner's accumulated reject-with-notes (optimizer-hero-
// preview-gate § grounding). `attemptIndex` keeps each candidate at a distinct storage path so the
// rejected attempts retain their own images. Returns the public URL (null on failure).
async function regenerateOptimizerHero(
  opt: typeof import("../src/lib/storefront/optimizer-agent"),
  surface: OptimizerSurfaceLite,
  plan: Record<string, unknown>,
  notes: string[],
  attemptIndex: number,
): Promise<string | null> {
  const variant = (plan.variant || {}) as Record<string, unknown>;
  const heroPrompt = String(variant.hero_prompt || "");
  if (!heroPrompt) return null;
  return opt.generateCampaignHero({
    workspaceId: surface.workspace_id,
    productId: surface.product_id,
    prompt: heroPrompt,
    slug: `${surface.lander_type}-${String(plan.lever_key || "hero")}-a${attemptIndex}`,
    landerType: surface.lander_type,
    notes,
  });
}

// Coerce a stored/parsed plan into an OptimizerProposal, generate the hero if the variant needs one,
// and stand up the M1 campaign via the library. Returns the library's MaterializeResult. When the
// preview gate already produced an owner-approved candidate (`approvedHeroUrl`), use it verbatim — the
// approved image is what goes live, never a fresh regen. Only the auto-run path (no preview gate) and a
// content lever fall through to generate-now (auto_run_reversible pre-authorized reversible auto-run).
async function materializeOptimizerCampaign(
  opt: typeof import("../src/lib/storefront/optimizer-agent"),
  surface: OptimizerSurfaceLite,
  plan: Record<string, unknown>,
  createdBy: string | null,
  conservative: boolean,
  approvedHeroUrl?: string,
): Promise<{ ok: boolean; detail: string }> {
  const variant = (plan.variant || {}) as Record<string, unknown>;
  let patch = (variant.patch || {}) as Record<string, unknown>;
  // kind='hero' → use the owner-approved candidate from the preview gate, else generate now (auto-run).
  if (String(variant.kind) === "hero") {
    let url = approvedHeroUrl;
    if (!url) {
      const heroPrompt = String(variant.hero_prompt || "");
      if (!heroPrompt) return { ok: false, detail: "hero variant missing hero_prompt" };
      url = (await regenerateOptimizerHero(opt, surface, plan, [], 0)) ?? undefined;
    }
    if (!url) return { ok: false, detail: "hero generation failed (no isolated product image / Gemini error)" };
    patch = { ...patch, heroImageUrl: url };
  }
  const proposal = {
    hypothesis: String(plan.hypothesis || ""),
    reasoning: String(plan.reasoning || ""),
    lever_key: String(plan.lever_key || ""),
    lever_class: "reversible" as const,
    lander_type: surface.lander_type as never,
    audience: surface.audience,
    holdout_pct: typeof plan.holdout_pct === "number" ? (plan.holdout_pct as number) : undefined,
    variant: { label: String(variant.label || "variant"), kind: "content" as const, patch: patch as never },
  };
  const r = await opt.materializeCampaign({
    workspaceId: surface.workspace_id,
    proposal,
    productId: surface.product_id,
    conservative,
    createdBy,
  });
  return { ok: r.ok, detail: r.detail };
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
  if (job.kind === "pr-resolve") return runPrResolveJob(job);
  if (job.kind === "repair") return runRepairJob(job);
  if (job.kind === "regression") return runRegressionJob(job);
  if (job.kind === "storefront-optimizer") return runStorefrontOptimizerJob(job);
  if (job.kind === "db_health") return runDbHealthJob(job);
  if (job.kind === "coverage-register") return runCoverageRegisterJob(job);
  const slug = job.spec_slug;
  const isResume = !!job.claude_session_id;
  const tag = `[${slug}]`;
  const wt = join(BUILDS_DIR, job.id); // isolated worktree — parallel builds never collide
  console.log(`${tag} ${isResume ? "resuming" : "building"} (job ${job.id}) in ${wt}`);

  // dirty-pr-resolver-duplicate-detection (Phase 1): build-claim dedup. A fresh build whose work already
  // shipped via a SIBLING build (same spec + same phase scope, already merged) must NOT open a competing PR
  // — that is exactly the duplicate the account-switch requeue created. No-op it as already-shipped instead
  // of building. Resumes are exempt (their branch/PR already exists; the merged sibling can't be them).
  if (!isResume) {
    try {
      const { findMergedSiblingBuild } = await import("../src/lib/agent-jobs");
      const sibling = await findMergedSiblingBuild(job.workspace_id, slug, {
        excludeJobId: job.id,
        instructions: job.instructions ?? null,
      });
      if (sibling) {
        const sib = sibling.pr_number ? `#${sibling.pr_number}` : (sibling.spec_branch ?? "a sibling build");
        await update(job.id, {
          status: "completed",
          pr_url: sibling.pr_number ? `https://github.com/${REPO}/pull/${sibling.pr_number}` : null,
          pr_number: sibling.pr_number ?? null,
          error: `already-shipped: ${slug} already merged via ${sib}`,
          log_tail: `Skipped build — ${slug} already shipped via ${sib} (same phase scope). No duplicate PR opened.`,
        });
        console.log(`${tag} already shipped via ${sib} — no-op (no duplicate PR)`);
        return;
      }
    } catch (e) {
      console.error(`${tag} merged-sibling dedup check failed (continuing to build):`, e instanceof Error ? e.message : e);
    }
  }

  // Multi-account (box-multi-account-failover Phase 1): pick the Max account this run uses. A NEW build
  // round-robins across healthy accounts; a RESUME pins to its session's owning account, or starts FRESH
  // on a healthy account if that one is capped (a build is idempotent — it re-reads the spec). If EVERY
  // account is capped, park `blocked_on_usage` (auto-resumes at reset) instead of building.
  const decision = resolveAccountForJob(job, isResume, /* canStartFresh */ true);
  if (decision.kind === "blocked") {
    await update(job.id, {
      status: "blocked_on_usage",
      error: `all ${ACCOUNT_POOL.length} Max account(s) at the usage wall — auto-resumes after ~${new Date(decision.resetAt).toISOString()}`,
      log_tail: `parked blocked_on_usage; soonest account reset ~${new Date(decision.resetAt).toISOString()}`,
    });
    console.warn(`${tag} all accounts capped → blocked_on_usage (reset ~${new Date(decision.resetAt).toISOString()})`);
    return;
  }
  const configDir = decision.configDir;
  let sessionId = decision.sessionId; // the claude session to --resume; null on a fresh / started-fresh run
  if (decision.startedFresh) {
    // Owning account capped → sacrifice the session context (branch WIP persists) and start fresh on a
    // healthy account. Clear the stored session + dir so this becomes a new session under `configDir`.
    await update(job.id, { claude_session_id: null, claude_session_config_dir: null });
    console.warn(`${tag} resume's owning account capped → starting fresh on ${configDir}`);
  }
  const chosenAccount = accountByDir.get(configDir)!;
  chosenAccount.inFlight++;
  chosenAccount.lastAssignedAt = Date.now();

  // Set up the worktree (its own dir + branch).
  sh("git", ["fetch", "origin"]);
  let branch = job.spec_branch;
  sh("git", ["worktree", "remove", "--force", wt]); // clear any leftover from a crashed run
  if (!isResume) {
    branch = `claude/${slug}-${Date.now().toString(36)}`;
    removeWorktreeForBranch(branch); // idempotent add — never collide with a prior tree holding this branch
    const add = sh("git", ["worktree", "add", "-B", branch, wt, "origin/main"]);
    if (add.code !== 0) throw new Error(`worktree add failed: ${add.err.slice(0, 300)}`);
    await update(job.id, { spec_branch: branch });
  } else {
    removeWorktreeForBranch(branch!); // kills "already used by worktree" on resume — re-establish the tree cleanly
    let add = sh("git", ["worktree", "add", "-B", branch!, wt, `origin/${branch}`]);
    if (add.code !== 0) add = sh("git", ["worktree", "add", "-B", branch!, wt, "origin/main"]); // branch not pushed → base on main
    if (add.code !== 0) throw new Error(`worktree add (resume) failed: ${add.err.slice(0, 300)}`);
  }
  // node_modules is gitignored (absent in a fresh worktree) → symlink the main clone's so tsc/builds work.
  // Force (-sfn) so a leftover/broken link from a prior run is always replaced.
  sh("ln", ["-sfn", join(REPO_DIR, "node_modules"), join(wt, "node_modules")]);

  // db-health-spec-body-robust (Phase 1): refuse to build a 0-byte / phaseless spec — belt-and-suspenders
  // against ANY empty spec reaching the builder (db-health or otherwise). It must FAIL loudly, never run
  // claude on an empty file and silently merge an empty PR. Resumes are exempt: the spec was validated on
  // the first pass and branch WIP already exists.
  if (!isResume) {
    const specPath = join(wt, "docs/brain/specs", `${slug}.md`);
    let specText = "";
    try { specText = readFileSync(specPath, "utf8"); } catch { /* missing → treated as empty below */ }
    if (!specText.trim() || !/^##\s+Phase/m.test(specText)) {
      const why = !specText.trim() ? "is empty / 0-byte / missing" : 'has no "## Phase" section';
      await update(job.id, {
        status: "failed",
        error: `spec docs/brain/specs/${slug}.md ${why} — refusing to build an empty spec (db-health-spec-body-robust)`,
        log_tail: `build aborted — docs/brain/specs/${slug}.md ${why}; no PR opened`,
      });
      console.error(`${tag} ${why} spec → failed (no silent empty merge)`);
      chosenAccount.inFlight--; // release the round-robin slot we took above (we return before the try/finally)
      sh("git", ["worktree", "remove", "--force", wt]);
      return;
    }
  }

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

    // `isResume && sessionId`: a started-fresh run (owning account was capped → sessionId cleared) has no
    // prior session to "continue", so it uses the FRESH prompt and re-reads the spec from the branch WIP.
    const prompt = isResume && sessionId
      ? `${resumeBits.join(". ") || "Resuming."}. Continue implementing docs/brain/specs/${slug}.md and finish. Same rules and the same final JSON output protocol as before.`
      : [
          `Use the build-spec skill to implement the spec at docs/brain/specs/${slug}.md (cwd is the repo root).`,
          ...(job.instructions ? [`SCOPE for THIS build — do exactly this and nothing more: ${job.instructions}`] : []),
          `Worker protocol (overrides the skill's git step): the harness owns version control — do NOT run git/push or open a PR. Author migrations/scripts as code (write-migration skill). You have NO prod credentials: to apply a migration or run a prod-mutating script, request approval instead of doing it. Run \`npx tsc --noEmit\` and fix errors you introduce. If you hit a product decision the spec doesn't cover, do NOT guess.`,
          `Final message = ONLY one JSON object: {"status":"completed","summary":"…"} | {"status":"needs_input","questions":[{"id","q"}]} | {"status":"needs_approval","actions":[{"type":"apply_migration|run_prod_script","summary":"what & why","cmd":"exact command, e.g. npx tsx scripts/apply-X-migration.ts"}]}. If you make NO file edits (nothing to build / already implemented), still return {"status":"completed","summary":"…","no_changes_reason":"why nothing changed"} — never claim done with no changes and no reason.`,
        ].join("\n");

    const { session, resultText, isError, raw } = await runClaude(prompt, sessionId, wt, configDir);
    const logTail = raw.slice(-2000);
    // Persist the session AND its owning account so a later resume can pin to it (never cross-account).
    if (session) await update(job.id, { claude_session_id: session, claude_session_config_dir: configDir });

    // Usage-cap failover (box-multi-account-failover Phase 1): a Max usage-WALL failure (NOT a transient
    // 529/overloaded — that's the existing retry) pulls this account from rotation. If a healthy account
    // remains, re-dispatch (resolveAccountForJob picks it / starts fresh next claim); else park
    // blocked_on_usage. Never a hard fail — the account rejoins after its reset.
    // A session pinned to the now-capped account can't resume there; passing `session` as hadSession keeps
    // it as queued_resume so the branch/PR is reused, and resolveAccountForJob starts fresh on a healthy
    // account at re-claim.
    if (isError && isUsageCapError(`${resultText}\n${raw}`)) {
      await handlePoolUsageCap(job.id, tag, configDir, !!session, logTail);
      return;
    }

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
    chosenAccount.inFlight--; // release the account's round-robin load slot
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
  console.log(`builder-worker up — repo ${REPO} @ ${RUNNING_SHA || "?"}, up to ${MAX_CONCURRENT} build lanes + ${MAX_FOLD} fold + ${MAX_SEED} seed + ${MAX_SPEC_CHAT} spec-chat + ${MAX_TICKET_IMPROVE} ticket-improve + ${MAX_TRIAGE} triage + ${MAX_SPEC_TEST} spec-test + ${MAX_MIGRATION_FIX} migration-fix + ${MAX_DEV_ASK} dev-ask + ${MAX_PR_RESOLVE} pr-resolve + ${MAX_REPAIR} repair lane, polling every ${POLL_MS}ms`);

  // Deploy-time Inngest re-sync (control-tower-complete-coverage spec, Phase 2): the worker
  // restarts right after it self-updates to a freshly-deployed SHA, so pinging the Inngest serve
  // endpoint here makes any newly-added createFunction register with Inngest Cloud instead of
  // silently never firing (the control-tower-monitor "awaiting first run for days" gap).
  // Fire-and-forget, best-effort — a failed sync must never block the worker loop.
  void (async () => {
    try {
      const { syncInngestRegistration } = await import("../src/lib/inngest/sync");
      const r = await syncInngestRegistration();
      console.log(`[inngest-sync] ${r.detail}`);
    } catch (e) {
      console.warn("[inngest-sync] skipped:", e instanceof Error ? e.message : e);
    }
  })();

  // Per-kind concurrency (fold-build-batching Phase 2): build+plan share the MAX_CONCURRENT pool;
  // kind='fold' gets its own concurrency-1 lane so a fold never races a feature build on the index files.
  // Per-lane detail (build-box-status-view): the value carries what the lane is building + when it
  // started, so each heartbeat tick can publish the full lane picture (kind/spec_slug/since).
  interface LaneInfo { kind: Job["kind"]; spec_slug: string; since: string; phase: string | null }
  const active = new Map<string, LaneInfo>();
  const countFold = () => [...active.values()].filter((v) => v.kind === "fold").length;
  const countSeed = () => [...active.values()].filter((v) => v.kind === "product-seed").length;
  const countSpecChat = () => [...active.values()].filter((v) => v.kind === "spec-chat").length;
  const countImprove = () => [...active.values()].filter((v) => v.kind === "ticket-improve").length;
  const countTriage = () => [...active.values()].filter((v) => v.kind === "triage-escalations").length;
  const countSpecTest = () => [...active.values()].filter((v) => v.kind === "spec-test").length;
  const countMigrationFix = () => [...active.values()].filter((v) => v.kind === "migration-fix").length;
  const countDevAsk = () => [...active.values()].filter((v) => v.kind === "dev-ask").length;
  const countPrResolve = () => [...active.values()].filter((v) => v.kind === "pr-resolve").length;
  const countRepair = () => [...active.values()].filter((v) => v.kind === "repair").length;
  const countRegression = () => [...active.values()].filter((v) => v.kind === "regression").length;
  const countStorefrontOptimizer = () => [...active.values()].filter((v) => v.kind === "storefront-optimizer").length;
  const countDbHealth = () => [...active.values()].filter((v) => v.kind === "db_health").length;
  const countCoverageRegister = () => [...active.values()].filter((v) => v.kind === "coverage-register").length;
  const countOther = () => [...active.values()].filter((v) => v.kind !== "fold" && v.kind !== "product-seed" && v.kind !== "spec-chat" && v.kind !== "ticket-improve" && v.kind !== "triage-escalations" && v.kind !== "spec-test" && v.kind !== "migration-fix" && v.kind !== "dev-ask" && v.kind !== "pr-resolve" && v.kind !== "repair" && v.kind !== "regression" && v.kind !== "storefront-optimizer" && v.kind !== "coverage-register").length;
  const launch = (job: Job) => {
    active.set(job.id, { kind: job.kind, spec_slug: job.spec_slug, since: new Date().toISOString(), phase: derivePhase(job.instructions) });
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

  // Reap orphans left in-flight by a previous instance (worker-orphan-reaper) before the poll loop opens.
  // Best-effort: a reaper failure must never block startup.
  try {
    await reapOrphans();
  } catch (e) {
    console.error("[reaper] reap failed (continuing):", e instanceof Error ? e.message : e);
  }
  // fold-guard-live-build (Phase 1): cancel any orphaned non-terminal job whose spec was archived.
  await reapArchivedSpecJobs();

  let steady = false; // flips true after the first clean poll tick → clears the crash-loop counter
  let lastApprovalSweep = 0; // approval-routing-engine M2: throttle the routed-inbox reconcile
  for (;;) {
    try {
      // Multi-account (box-multi-account-failover Phase 1): revive any job parked `blocked_on_usage` once
      // an account has reset — flip it back to queued/queued_resume so the lanes below re-claim it. No
      // manual re-queue / rebuild. Best-effort.
      try {
        noteAccountRecoveries(Date.now()); // log a `recovered` event for any account whose cap window expired
        await requeueBlockedOnUsage();
      } catch (e) {
        console.error("[multi-account] blocked_on_usage requeue failed (continuing):", e instanceof Error ? e.message : e);
      }

      // Approval routing (approval-routing-engine spec, M2): the "one inbox, no orphans" sweep. Surface
      // every open needs_approval job as a routed Approval Request in the M1 inbox (and dismiss the ones
      // whose job has been decided). The single chokepoint — catches every kind regardless of which
      // surface raised it. Throttled to ~20s; best-effort, never breaks the poll loop.
      if (Date.now() - lastApprovalSweep > 20_000) {
        lastApprovalSweep = Date.now();
        try {
          const { reconcileApprovalInbox } = await import("../src/lib/agents/approval-inbox");
          const r = await reconcileApprovalInbox(db);
          if (r.created || r.dismissed) console.log(`[approval-inbox] +${r.created} request(s), -${r.dismissed} dismissed`);
        } catch (e) {
          console.error("[approval-inbox] reconcile failed (continuing):", e instanceof Error ? e.message : e);
        }
      }
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
      // Fill the pr-resolve lane (dirty-pr-resolver-agent): webhook-fired dirty claude/* PR resolve, concurrency-1.
      while (countPrResolve() < MAX_PR_RESOLVE) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["pr-resolve"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed pr-resolve ${job.id.slice(0, 8)} → ${countPrResolve() + 1}/${MAX_PR_RESOLVE} pr-resolve lane`);
        launch(job);
      }
      // Fill the repair lane (repair-agent): event-fired Control Tower triage, read-only diagnose → propose-fix.
      while (countRepair() < MAX_REPAIR) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["repair"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed repair ${job.id.slice(0, 8)} → ${countRepair() + 1}/${MAX_REPAIR} repair lane`);
        launch(job);
      }
      // Fill the regression lane (regression-agent): spec-test-fired ✅-now-failing review, read-only
      // review → dismiss-with-reasoning OR author the fix spec directly + route to the inbox. Concurrency-1.
      while (countRegression() < MAX_REGRESSION) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["regression"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed regression ${job.id.slice(0, 8)} → ${countRegression() + 1}/${MAX_REGRESSION} regression lane`);
        launch(job);
      }
      // Fill the db_health lane (db-health-agent): owner Build resume on a surfaced proposal —
      // materialize the pre-authored fix spec to main + queue its build. Concurrency-1, fast.
      while (countDbHealth() < MAX_DB_HEALTH) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["db_health"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed db_health ${job.id.slice(0, 8)} → ${countDbHealth() + 1}/${MAX_DB_HEALTH} db_health lane`);
        launch(job);
      }
      // Fill the coverage-register lane (coverage-register-agent): owner Register/Exempt resume on a
      // surfaced unregistered-loop proposal — materialize the chosen registry fix spec + queue its build.
      while (countCoverageRegister() < MAX_COVERAGE_REGISTER) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["coverage-register"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed coverage-register ${job.id.slice(0, 8)} → ${countCoverageRegister() + 1}/${MAX_COVERAGE_REGISTER} coverage-register lane`);
        launch(job);
      }
      // Fill the storefront-optimizer lane (storefront-optimizer-agent): scheduled campaign cycle —
      // read funnel+lever map+proxy → propose a hypothesis/variant → stand up an M1 experiment (or
      // surface a missing-capability spec). Own concurrency-1 lane, read-only diagnose on Max.
      while (countStorefrontOptimizer() < MAX_STOREFRONT_OPTIMIZER) {
        const { data } = await db.rpc("claim_agent_job", { p_kinds: ["storefront-optimizer"] });
        const job = (Array.isArray(data) ? data[0] : data) as Job | null;
        if (!job || !job.id) break;
        console.log(`claimed storefront-optimizer ${job.id.slice(0, 8)} → ${countStorefrontOptimizer() + 1}/${MAX_STOREFRONT_OPTIMIZER} storefront-optimizer lane`);
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

      // Heartbeat for the dashboard, then self-update if no SACROSANCT lane is running.
      const lanes: LaneRow[] = [...active.entries()].map(([job_id, v]) => ({ kind: v.kind, job_id, spec_slug: v.spec_slug, since: v.since, phase: v.phase }));
      await writeHeartbeat(active.size, "healthy", undefined, lanes);

      // Control Tower migration-drift check (control-tower-migration-drift-check P1): fire-and-forget
      // on its ~30 min cadence, with an in-flight guard so a slow DB read never overlaps or stalls the
      // poll loop. Detection lives on the box because the deployed runtime can't read the .sql files.
      if (!migrationDriftInFlight && Date.now() - lastMigrationDriftCheck > MIGRATION_DRIFT_INTERVAL_MS) {
        lastMigrationDriftCheck = Date.now();
        migrationDriftInFlight = true;
        void runMigrationDriftJob().finally(() => { migrationDriftInFlight = false; });
      }

      // DB Health Agent (db-health-agent P1): two box-side passes, each fire-and-forget on its own
      // cadence with an in-flight guard. The frequent slow-query root-cause pass (~hourly) + the daily
      // size/growth/index/bloat sweep. Both read pg_stat_* / run EXPLAIN via the pooler (the deployed
      // runtime can't), snapshot + classify read-only, and PROPOSE deduped fix specs — zero DDL.
      if (!dbHealthSlowQInFlight && Date.now() - lastDbHealthSlowQ > DB_HEALTH_SLOWQ_INTERVAL_MS) {
        lastDbHealthSlowQ = Date.now();
        dbHealthSlowQInFlight = true;
        void runDbHealthSlowQueryJob().finally(() => { dbHealthSlowQInFlight = false; });
      }
      if (!dbHealthSizeInFlight && Date.now() - lastDbHealthSize > DB_HEALTH_SIZE_INTERVAL_MS) {
        lastDbHealthSize = Date.now();
        dbHealthSizeInFlight = true;
        void runDbHealthSizeJob().finally(() => { dbHealthSizeInFlight = false; });
      }
      // Only build/plan/fold/product-seed/spec-chat/ticket-improve produce durable work (a PR, published
      // content, a user's mid-turn) that a restart would lose — those block self-update. The autonomous,
      // idempotent, re-runnable lanes (spec-test, triage-escalations, migration-fix, dev-ask, pr-resolve)
      // do NOT: a restart just re-claims them from the queue. Otherwise a long re-test sweep (e.g. the
      // human→machine reclassification backfill) keeps a lane busy indefinitely and the box never updates.
      const sacrosanctActive = [...active.values()].filter((v) => !RERUNNABLE_KINDS.has(v.kind)).length;
      await maybeSelfUpdate(sacrosanctActive); // exits (→ systemd restart) when behind origin/main + no sacrosanct lane running
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
