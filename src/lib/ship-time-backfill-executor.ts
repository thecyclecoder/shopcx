/**
 * ship-time-backfill-executor — Fix 1 for
 * [[../../docs/brain/specs/ship-time-data-backfills-run-and-ledgered-not-silently-dead-code]]
 * (resolves the two pre-merge spec-test regressions Phase 2's verification named).
 *
 * The Phase-1 detector ledgers every shipped `scripts/_backfill-*.ts` as a `pending`
 * `data_op_runs` row and escalates it to the CEO inbox — the safety net that makes an un-run
 * backfill VISIBLE. This module CLOSES THE LOOP for idempotent scripts: on the box (where the
 * repo working tree + a Supabase admin connection both exist), read every `pending` row for a
 * merged spec, spawn `npx tsx <script>` once per row via `child_process.spawn`, capture exit
 * code + stderr, and record the outcome on the SAME row:
 *
 *   - exit 0        → status='ran', ran_at=now(), error=null
 *   - non-zero/throw → status='failed', error=stderr (truncated)
 *
 * Every write is a **compare-and-set** on `(id, workspace_id, status='pending')` so a
 * concurrent executor pass never overwrites a status the other one just flipped. The
 * write returns `.select('id')` so the caller sees exactly-one-row-transitioned (per the
 * confirming-predicate coaching — an async read followed by a bare `.eq('id', …).update` is
 * the class-11 slip the coaching guards against; not this).
 *
 * The `script_path` is a spec-authored field ledgered from a merged diff — treat it as an
 * UNTRUSTED capability boundary before it reaches `spawn`. Two rails:
 *   1. `isBackfillScriptPath` — the same bounded convention regex the detector uses
 *     (`^scripts/_backfill-[a-z0-9][a-z0-9._-]*\.ts$`) — rejects option-looking values
 *     (leading `-`), absolute paths, path traversal (`..`), and any name outside
 *     `scripts/_backfill-*.ts`.
 *   2. `spawn("npx", ["tsx", "--", scriptPath])` — array argv (never a shell string) with
 *     an explicit `--` separator so tsx's own argument parser can't consume the path as a
 *     flag even hypothetically.
 *
 * BOX-ONLY: the deployed Next runtime has neither the `tsx` binary nor the repo working
 * tree. This module is invoked from the box worker's post-merge on-box pass (mirrors
 * where `applyMergedMigrations` runs today) — never from the deployed webhook path.
 *
 * Best-effort by contract — `executeShipTimeBackfillsForSpec` never throws.
 */

import { spawn } from "child_process";
import { errText } from "@/lib/error-text";
import { resolve, isAbsolute } from "path";
import { createAdminClient } from "@/lib/supabase/admin";
import { isBackfillScriptPath } from "@/lib/ship-time-backfill-detector";

type Admin = ReturnType<typeof createAdminClient>;

/** Max bytes of stderr we persist per failed row — keep the ledger's `error` column bounded. */
const MAX_ERROR_BYTES = 4000;

/** Per-script execution deadline. A backfill that hangs longer is force-killed and marked failed. */
const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60_000;

/** Outcome the executor emits per run — carried on the box job's log so the tile can show what happened. */
export interface ShipTimeBackfillExecutionSummary {
  /** merged spec slug the executor drained. */
  specSlug: string;
  /** number of pending rows the executor picked up. */
  pending: number;
  /** number of rows the executor transitioned to status='ran'. */
  ran: number;
  /** number of rows the executor transitioned to status='failed'. */
  failed: number;
  /** number of rows the executor SKIPPED because the script_path failed capability validation. */
  rejected: number;
  /** number of rows another concurrent pass already advanced (compare-and-set returned 0 rows). */
  raced: number;
}

interface ExecuteArgs {
  workspaceId: string;
  specSlug: string;
  /** absolute path of the repo working tree the script resolves under. */
  repoDir: string;
  /** override for the per-script deadline (tests pin this). */
  execTimeoutMs?: number;
}

/**
 * Drain every `pending` `data_op_runs` row for `specSlug` — spawn each script via
 * `npx tsx`, capture the outcome, and write `status='ran'` / `status='failed'` back with a
 * compare-and-set. Idempotent + best-effort — never throws. A row a concurrent pass already
 * advanced (compare-and-set matches zero rows) is counted as `raced`, not double-executed.
 */
export async function executeShipTimeBackfillsForSpec(
  args: ExecuteArgs,
): Promise<ShipTimeBackfillExecutionSummary> {
  const summary: ShipTimeBackfillExecutionSummary = {
    specSlug: args.specSlug,
    pending: 0,
    ran: 0,
    failed: 0,
    rejected: 0,
    raced: 0,
  };
  try {
    const admin = createAdminClient();
    const { data: pendingRows } = await admin
      .from("data_op_runs")
      .select("id, script_path, workspace_id")
      .eq("workspace_id", args.workspaceId)
      .eq("spec_slug", args.specSlug)
      .eq("status", "pending");
    const rows = (pendingRows ?? []) as Array<{ id: string; script_path: string; workspace_id: string }>;
    summary.pending = rows.length;
    for (const row of rows) {
      // Capability boundary — a spec-authored script_path must clear the bounded regex before
      // it reaches spawn. A path that fails validation is written back as `failed` with an
      // explicit error so the escalation loop still sees the row (never silently drops).
      if (!isValidScriptPathForExec(row.script_path)) {
        summary.rejected += 1;
        await recordFailure(admin, {
          id: row.id,
          workspaceId: row.workspace_id,
          error: `rejected: script_path "${row.script_path}" is not a valid scripts/_backfill-*.ts path`,
        });
        continue;
      }
      const outcome = await spawnBackfill({
        repoDir: args.repoDir,
        scriptPath: row.script_path,
        timeoutMs: args.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      });
      if (outcome.ok) {
        const flipped = await recordSuccess(admin, { id: row.id, workspaceId: row.workspace_id });
        if (flipped) summary.ran += 1;
        else summary.raced += 1;
      } else {
        const flipped = await recordFailure(admin, {
          id: row.id,
          workspaceId: row.workspace_id,
          error: outcome.error.slice(0, MAX_ERROR_BYTES),
        });
        if (flipped) summary.failed += 1;
        else summary.raced += 1;
      }
    }
    return summary;
  } catch (e) {
    console.warn(
      `[ship-time-backfill-executor] execute failed for spec=${args.specSlug}: ${errText(e)}`,
    );
    return summary;
  }
}

/**
 * Second-line capability gate before spawn — the ledger's `script_path` came from a merged
 * diff (an untrusted spec-authored field). Enforce (a) the bounded backfill regex, (b) no
 * absolute path, (c) no `..` segment (path traversal), and (d) no leading `-` (option-lookalike).
 */
export function isValidScriptPathForExec(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("-")) return false;
  if (isAbsolute(path)) return false;
  if (path.includes("..")) return false;
  return isBackfillScriptPath(path);
}

interface SpawnResult {
  ok: boolean;
  /** stderr captured from the child (empty on success). */
  error: string;
}

/** Spawn one `npx tsx <script>` under the repo working tree. Never throws. */
function spawnBackfill(args: {
  repoDir: string;
  scriptPath: string;
  timeoutMs: number;
}): Promise<SpawnResult> {
  return new Promise<SpawnResult>((res) => {
    // Resolve under the repo root so a relative script_path can't escape the tree.
    const abs = resolve(args.repoDir, args.scriptPath);
    if (!abs.startsWith(resolve(args.repoDir) + "/")) {
      res({ ok: false, error: `refused: resolved path escapes repoDir (${abs})` });
      return;
    }
    // spawn with argv array (NEVER a shell string). `--` separator so tsx's own arg parser
    // treats scriptPath as a positional argument, not a flag — defense-in-depth against a
    // maliciously-authored path that somehow bypassed the regex.
    const child = spawn("npx", ["tsx", "--", args.scriptPath], {
      cwd: args.repoDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* best-effort — the exit handler will still fire */
      }
      res({ ok: false, error: `timed out after ${args.timeoutMs}ms\n${stderr}`.slice(0, MAX_ERROR_BYTES) });
    }, args.timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_ERROR_BYTES) stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 2000) stdout += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ ok: false, error: `spawn failed: ${err.message}` });
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        res({ ok: true, error: "" });
      } else {
        const tag = signal ? `killed by ${signal}` : `exit ${code ?? "?"}`;
        res({ ok: false, error: `${tag}\n${stderr || stdout}`.slice(0, MAX_ERROR_BYTES) });
      }
    });
  });
}

/**
 * Flip a `pending` row to `ran` with a compare-and-set. Returns true iff exactly one row
 * transitioned (the confirming predicate + `.select('id')` per coaching #11) — a concurrent
 * pass that already advanced the row leaves us with zero matches, which the caller records
 * as a `raced` outcome (never double-executed).
 */
async function recordSuccess(
  admin: Admin,
  args: { id: string; workspaceId: string },
): Promise<boolean> {
  const { data } = await admin
    .from("data_op_runs")
    .update({
      status: "ran",
      ran_at: new Date().toISOString(),
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.id)
    .eq("workspace_id", args.workspaceId)
    .eq("status", "pending")
    .select("id");
  return Array.isArray(data) && data.length === 1;
}

/**
 * Flip a `pending` row to `failed` with a compare-and-set + captured stderr. Same
 * guard shape as `recordSuccess` — one row transitions, or zero if a concurrent pass got
 * there first (raced).
 */
async function recordFailure(
  admin: Admin,
  args: { id: string; workspaceId: string; error: string },
): Promise<boolean> {
  const { data } = await admin
    .from("data_op_runs")
    .update({
      status: "failed",
      error: args.error,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.id)
    .eq("workspace_id", args.workspaceId)
    .eq("status", "pending")
    .select("id");
  return Array.isArray(data) && data.length === 1;
}
