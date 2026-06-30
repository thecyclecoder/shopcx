/**
 * Box crash-loop watchdog (box-crash-loop-watchdog).
 *
 * THE INCIDENT this exists to prevent: the build worker (`systemd shopcx-builder`,
 * scripts/builder-worker.ts) crash-looped for ~5 HOURS on a syntax error,
 * completely unnoticed. `systemctl restart` returns success when it ISSUES the
 * restart, not when the worker actually comes up healthy — so every "restart"
 * looked fine while the service `activating → failed → auto-restart` looped
 * (restart counter climbed to 11). The worker's OWN crash guard (recordStartupAttempt
 * in builder-worker.ts) can't catch a *parse* error: a syntax error kills the module
 * before `main()` runs, so the per-SHA counter never increments and nothing parks it.
 * Nobody knew until the CEO noticed work wasn't moving.
 *
 * WHAT THIS IS: a SEPARATE, dead-simple monitor that runs from OUTSIDE the worker
 * (its own systemd timer, ~every 60s) so it SURVIVES a worker crash. It does NOT
 * modify the worker. Each tick it:
 *   1. DETECTS a crash-loop — distinguishing a genuine crash-loop (repeated
 *      status=1/FAILURE exits in a short window) from a normal self-update restart
 *      (a CLEAN exit=0 that comes back up healthy) or a single transient blip.
 *   2. ALERTS the CEO LOUDLY — an open loop_alert (owner=platform, severity critical)
 *      + a CEO-routed dashboard_notification, carrying the failing SHA + the captured
 *      esbuild/Node error. Fires independently of the worker being up (own process + DB).
 *   3. AUTO-ROLLS-BACK the box checkout to the last SHA that booted healthy
 *      (git reset --hard <good-sha> + restart) and VERIFIES it comes up healthy —
 *      so the box runs good code again while the CEO fixes the bad commit. It does
 *      NOT revert main (only the box's checkout), so the CEO still sees + fixes the
 *      bad commit. Because the worker self-updates back to origin/main when idle, the
 *      watchdog QUARANTINES the bad SHA and RE-ASSERTS the rollback every tick until
 *      main is fixed (see § Self-update race below).
 *
 * VERIFY-AFTER-RESTART HELPER: `tsx scripts/box-watchdog.ts --verify` confirms the
 * worker actually came up healthy (is-active=active + the `up —` heartbeat line within
 * ~15s) — the reusable check so a future deploy can't "succeed" while the worker is dead.
 *
 * ── How a self-update restart is told apart from a crash-loop ──
 * A self-update is a CLEAN exit: the worker logs `status='updating'`, `process.exit(0)`
 * → systemd logs "Deactivated successfully" / "Stopped", NOT "status=1/FAILURE", then a
 * fresh `builder-worker up — … @ <sha>` line and is-active=active. So failureCount
 * stays 0 and the next tick reads healthy. A crash-loop is repeated
 * "Main process exited, code=exited, status=1/FAILURE" + a climbing restart counter, with
 * NO `up —` line after the failures (the worker dies before it boots). The watchdog only
 * ACTS on a CONFIRMED crash-loop: >= CRASH_FAILURES FAILURE exits within WINDOW_MIN, OR
 * >= UNHEALTHY_CONSEC consecutive unhealthy watchdog ticks, OR the box is back on the
 * quarantined bad SHA. A lone clean restart (1 transient blip) never trips it.
 *
 * ── Known-good SHA ──
 * Persisted in STATE_FILE. Set to the SHA from the most recent `builder-worker up — … @ <sha>`
 * line (falling back to the live checkout HEAD) ONLY on a tick the worker is confirmed healthy
 * (is-active=active AND zero FAILURE exits in the window). Durable, so even a 5-hour crash-loop
 * window with no `up —` line still has a known-good target to roll back to.
 *
 * ── Self-update race (why the rollback re-asserts) ──
 * The worker self-updates its OWN checkout to origin/main when idle (maybeSelfUpdate in
 * builder-worker.ts) — there is no hold/pin switch, and the worker is OUT OF SCOPE to edit.
 * So after a rollback the worker will, within one idle cycle, re-pull the bad origin/main and
 * crash again. The watchdog therefore QUARANTINES the bad SHA: every subsequent tick, if the
 * checkout HEAD is back on the quarantined bad SHA it immediately re-rolls to known-good. Net:
 * the box runs good code the vast majority of the time (oscillating only for the few seconds
 * between a worker re-pull and the next watchdog tick), and stays LOUDLY alerted, until the CEO
 * fixes main (then the box self-updates to the new good SHA and the watchdog clears quarantine
 * + resolves the alert). The permanent fix — a `WORKER_PIN_SHA` env the worker's self-update
 * respects — is a worker-side follow-up (this watchdog must not edit the worker).
 *
 * Read-mostly + best-effort: DB writes are wrapped so a Supabase outage never stops the
 * survival action (the rollback runs regardless of whether the alert landed).
 *
 * Run as ROOT (it calls systemctl/journalctl and restarts the service); git ops in the
 * worker repo run as the `builder` user (runuser) to avoid git "dubious ownership".
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { createAdminClient } from "./_bootstrap";

// ── Config (env-overridable) ────────────────────────────────────────────────
const SERVICE = process.env.WATCHDOG_SERVICE || "shopcx-builder";
const REPO_DIR = process.env.WATCHDOG_REPO_DIR || "/home/builder/shopcx";
const REPO_USER = process.env.WATCHDOG_REPO_USER || "builder";
const STATE_FILE = process.env.WATCHDOG_STATE_FILE || "/home/builder/.box-watchdog.json";

const WINDOW_MIN = 6; // journal lookback window (T) for counting FAILURE exits
const CRASH_FAILURES = 3; // M — FAILURE exits within WINDOW_MIN that confirm a crash-loop
const UNHEALTHY_CONSEC = 3; // consecutive unhealthy watchdog ticks that also confirm it
const HEARTBEAT_FRESH_MS = 120_000; // worker_heartbeats.last_poll_at freshness (positive health confirm)
const VERIFY_TIMEOUT_MS = 20_000; // how long to wait for a healthy boot after a restart
const VERIFY_POLL_MS = 2_000;

// ── State ────────────────────────────────────────────────────────────────────
interface WatchdogState {
  knownGoodSha: string | null;
  knownGoodAt: string | null;
  consecutiveUnhealthy: number;
  lastHealthyAt: string | null;
  quarantinedSha: string | null; // a bad SHA we've rolled away from; re-assert if the box returns to it
  alertedSha: string | null; // failing SHA we've already paged on (de-dupe the page)
  lastRollback: { from: string; to: string; at: string; verified: boolean } | null;
}

function readState(): WatchdogState {
  try {
    if (existsSync(STATE_FILE)) {
      const o = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      return {
        knownGoodSha: o.knownGoodSha ?? null,
        knownGoodAt: o.knownGoodAt ?? null,
        consecutiveUnhealthy: Number(o.consecutiveUnhealthy) || 0,
        lastHealthyAt: o.lastHealthyAt ?? null,
        quarantinedSha: o.quarantinedSha ?? null,
        alertedSha: o.alertedSha ?? null,
        lastRollback: o.lastRollback ?? null,
      };
    }
  } catch {
    /* corrupt → fresh */
  }
  return {
    knownGoodSha: null,
    knownGoodAt: null,
    consecutiveUnhealthy: 0,
    lastHealthyAt: null,
    quarantinedSha: null,
    alertedSha: null,
    lastRollback: null,
  };
}

function writeState(s: WatchdogState): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error(`[watchdog] state write failed: ${e instanceof Error ? e.message : e}`);
  }
}

// ── Shell helpers (never throw on non-zero — capture output) ─────────────────
function run(cmd: string, args: string[], timeoutMs = 30_000): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out: out || "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const out = `${err.stdout?.toString() || ""}${err.stderr?.toString() || ""}`;
    return { code: typeof err.status === "number" ? err.status : 1, out };
  }
}

/** git in the worker repo, as the `builder` user (avoids "dubious ownership" when run as root). */
function git(args: string[], timeoutMs = 60_000): { code: number; out: string } {
  return run("runuser", ["-u", REPO_USER, "--", "git", "-C", REPO_DIR, ...args], timeoutMs);
}

function isActive(): string {
  // is-active exits non-zero when not active; the stdout word is what we want.
  return run("systemctl", ["is-active", SERVICE], 10_000).out.trim() || "unknown";
}

function readJournal(minutes: number): string {
  return run("journalctl", ["-u", SERVICE, "--since", `${minutes} min ago`, "--no-pager", "-o", "cat"], 20_000).out;
}

// ── Journal parsing ──────────────────────────────────────────────────────────
interface JournalSummary {
  failureCount: number; // "Main process exited, code=exited, status=N/FAILURE" (N != 0)
  restartCounter: number; // max "restart counter is at N"
  upSha: string | null; // SHA from the most recent "builder-worker up — … @ <sha>"
  errorLine: string | null; // a captured Node/esbuild error line (the cause)
}

function parseJournal(text: string): JournalSummary {
  const lines = text.split("\n");
  let failureCount = 0;
  let restartCounter = 0;
  let upSha: string | null = null;
  let errorLine: string | null = null;

  // A Node/esbuild crash cause. Captures esbuild parse errors, missing modules, and JS runtime errors.
  const errorRe = /(SyntaxError|ReferenceError|TypeError|RangeError|Transform failed|Build failed|Expected .* but found|Unexpected|Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|esbuild|ENOENT|Unterminated)/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // systemd FAILURE exit (a crash) — NOT a clean exit=0 self-update.
    const m = line.match(/Main process exited, code=exited, status=(\d+)\/FAILURE/);
    if (m && Number(m[1]) !== 0) failureCount++;
    else if (/Failed with result 'exit-code'/.test(line)) failureCount++; // belt-and-suspenders
    const rc = line.match(/restart counter is at (\d+)/);
    if (rc) restartCounter = Math.max(restartCounter, Number(rc[1]));
    const up = line.match(/builder-worker up\b.*?@\s+(\S+?)[,\s]/);
    if (up) upSha = up[1];
    if (errorRe.test(line)) errorLine = line.slice(0, 400);
  }
  return { failureCount, restartCounter, upSha, errorLine };
}

function shortSha(s: string | null | undefined): string {
  return (s || "").slice(0, 12);
}

// ── DB: resolve the build-console workspace (same heuristic as spec-test-cron) ──
async function resolveWorkspaceId(admin: ReturnType<typeof createAdminClient>): Promise<string | null> {
  try {
    const { data } = await admin
      .from("agent_jobs")
      .select("workspace_id")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as { workspace_id?: string } | null)?.workspace_id ?? null;
  } catch {
    return null;
  }
}

async function isHeartbeatFresh(admin: ReturnType<typeof createAdminClient>): Promise<boolean | null> {
  try {
    const { data } = await admin.from("worker_heartbeats").select("last_poll_at").eq("id", "box").maybeSingle();
    const lp = (data as { last_poll_at?: string } | null)?.last_poll_at;
    if (!lp) return null;
    return Date.now() - new Date(lp).getTime() < HEARTBEAT_FRESH_MS;
  } catch {
    return null;
  }
}

const ALERT_LOOP_ID = "box-crash-loop"; // distinct from the registry "box" loop → the control-tower monitor never touches it

/** Open (or refresh) the single critical loop_alert + a CEO-routed dashboard_notification. Best-effort. */
async function writeAlert(
  admin: ReturnType<typeof createAdminClient>,
  failingSha: string,
  errorLine: string | null,
  rollback: { to: string; verified: boolean } | null,
  noGood: boolean,
): Promise<void> {
  const signature = `box_crash_loop:${failingSha}`;
  const errTxt = errorLine ? ` Error: ${errorLine}` : "";
  const rbTxt = rollback
    ? ` Auto-rolled the box checkout back to last-known-good ${shortSha(rollback.to)} (${rollback.verified ? "verified healthy" : "restart issued, health UNCONFIRMED"}); main is UNCHANGED — the bad commit ${shortSha(failingSha)} is still on main, fix + redeploy. Watchdog re-asserts the rollback each tick until main is fixed.`
    : noGood
      ? ` No known-good SHA recorded yet — cannot auto-rollback; manual intervention needed.`
      : "";
  const detail = `Box build worker crash-looping on ${shortSha(failingSha)} (>= ${CRASH_FAILURES} FAILURE exits in ${WINDOW_MIN} min).${errTxt}${rbTxt}`;

  // 1) loop_alert (global infra, Control Tower) — one OPEN row, refreshed across ticks.
  try {
    const { data: open } = await admin
      .from("loop_alerts")
      .select("id")
      .eq("status", "open")
      .eq("loop_id", ALERT_LOOP_ID)
      .maybeSingle();
    if (open) {
      await admin
        .from("loop_alerts")
        .update({ detail, signature, last_seen_at: new Date().toISOString() })
        .eq("id", (open as { id: string }).id);
    } else {
      const { error } = await admin.from("loop_alerts").insert({
        loop_id: ALERT_LOOP_ID,
        kind: "worker",
        owner: "platform",
        signature,
        reason: "crash_loop",
        detail,
      });
      if (error && (error as { code?: string }).code !== "23505") {
        console.error(`[watchdog] loop_alerts insert failed: ${error.message}`);
      }
    }
  } catch (e) {
    console.error(`[watchdog] loop_alerts write failed: ${e instanceof Error ? e.message : e}`);
  }

  // 2) CEO-routed dashboard_notification — de-duped per failing SHA.
  try {
    const workspaceId = await resolveWorkspaceId(admin);
    if (workspaceId) {
      const dedupeKey = `box_crash_loop:${failingSha}`;
      const { data: existing } = await admin
        .from("dashboard_notifications")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("metadata->>dedupe_key", dedupeKey)
        .limit(1);
      if (!existing || !existing.length) {
        const { error } = await admin.from("dashboard_notifications").insert({
          workspace_id: workspaceId,
          type: "system",
          title: rollback ? `Box crash-loop — auto-rolled back` : `Box crash-loop detected`,
          body: detail,
          link: "/dashboard/developer/control-tower",
          metadata: {
            dedupe_key: dedupeKey,
            kind: "box_crash_loop",
            failing_sha: failingSha,
            good_sha: rollback?.to ?? null,
            rolled_back: !!rollback,
            error: errorLine ?? null,
          },
          read: false,
          dismissed: false,
        });
        if (error) console.error(`[watchdog] dashboard_notifications insert failed: ${error.message}`);
      }
    }
  } catch (e) {
    console.error(`[watchdog] notification write failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Resolve the open crash-loop alert when the box is healthy again. Best-effort. */
async function resolveAlert(admin: ReturnType<typeof createAdminClient>): Promise<void> {
  try {
    const { data: open } = await admin
      .from("loop_alerts")
      .select("id")
      .eq("status", "open")
      .eq("loop_id", ALERT_LOOP_ID)
      .maybeSingle();
    if (open) {
      await admin
        .from("loop_alerts")
        .update({ status: "resolved", resolved_at: new Date().toISOString() })
        .eq("id", (open as { id: string }).id);
      console.log("[watchdog] resolved open crash-loop alert (box healthy)");
    }
  } catch (e) {
    console.error(`[watchdog] resolveAlert failed: ${e instanceof Error ? e.message : e}`);
  }
}

// ── Rollback + verify ────────────────────────────────────────────────────────
/** Roll the box checkout back to a known-good SHA + restart. Returns whether it verified healthy. */
function rollbackTo(goodSha: string): boolean {
  console.log(`[watchdog] ROLLBACK → reset ${REPO_DIR} to last-known-good ${shortSha(goodSha)} + restart ${SERVICE}`);
  const reset = git(["reset", "--hard", goodSha]);
  if (reset.code !== 0) {
    console.error(`[watchdog] git reset --hard ${shortSha(goodSha)} failed: ${reset.out.slice(0, 300)}`);
    // Last resort: try to at least restart so systemd re-attempts.
  }
  run("systemctl", ["restart", SERVICE], 30_000);
  return verifyHealthy();
}

/**
 * Verify the worker actually came up healthy after a restart/deploy:
 * is-active=active AND a fresh `builder-worker up — … @ <sha>` line, within VERIFY_TIMEOUT_MS.
 * This is the discipline gap that hid the 5h outage — `systemctl restart` returning 0 is NOT health.
 */
function verifyHealthy(): boolean {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const active = isActive();
    if (active === "active") {
      // Confirm it actually BOOTED (logged the up line) since the restart, not just "active=activating-passed".
      const j = parseJournal(readJournal(2));
      if (j.upSha && j.failureCount === 0) {
        console.log(`[watchdog] verify OK — active + up — @ ${shortSha(j.upSha)}`);
        return true;
      }
    }
    execFileSync("sleep", [String(VERIFY_POLL_MS / 1000)]); // block ~VERIFY_POLL_MS without a busy loop
  }
  console.error(`[watchdog] verify FAILED — worker not healthy within ${VERIFY_TIMEOUT_MS / 1000}s (active=${isActive()})`);
  return false;
}

// ── Verify-only mode (reusable post-deploy check) ────────────────────────────
function runVerifyMode(): never {
  const ok = verifyHealthy();
  console.log(ok ? "HEALTHY" : "UNHEALTHY");
  process.exit(ok ? 0 : 1);
}

// ── Main tick ────────────────────────────────────────────────────────────────
async function tick(): Promise<void> {
  const state = readState();
  const active = isActive();
  const journal = parseJournal(readJournal(WINDOW_MIN));
  const curSha = git(["rev-parse", "--short", "HEAD"]).out.trim() || "";

  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error(`[watchdog] admin client unavailable (DB writes will skip): ${e instanceof Error ? e.message : e}`);
  }
  const hbFresh = admin ? await isHeartbeatFresh(admin) : null;

  const healthy = active === "active" && journal.failureCount === 0;

  if (healthy) {
    // Record known-good (prefer the SHA the worker logged it booted on; fall back to live HEAD).
    const good = journal.upSha || curSha || state.knownGoodSha;
    state.knownGoodSha = good || state.knownGoodSha;
    state.knownGoodAt = new Date().toISOString();
    state.lastHealthyAt = new Date().toISOString();
    state.consecutiveUnhealthy = 0;
    // The box is healthy on a SHA that is NOT the quarantined bad one → main was fixed; clear quarantine + alert.
    if (state.quarantinedSha && curSha && curSha !== state.quarantinedSha) {
      console.log(`[watchdog] box healthy on ${shortSha(curSha)} (!= quarantined ${shortSha(state.quarantinedSha)}) — clearing quarantine`);
      state.quarantinedSha = null;
      state.alertedSha = null;
      if (admin) await resolveAlert(admin);
    } else if (!state.quarantinedSha) {
      state.alertedSha = null;
      if (admin) await resolveAlert(admin);
    }
    writeState(state);
    console.log(`[watchdog] healthy — active, 0 failures/${WINDOW_MIN}min, sha=${shortSha(curSha)}, known-good=${shortSha(state.knownGoodSha)}${hbFresh === false ? " (warn: heartbeat stale)" : ""}`);
    return;
  }

  // Unhealthy this tick.
  state.consecutiveUnhealthy += 1;
  const backOnQuarantined = !!state.quarantinedSha && curSha === state.quarantinedSha;
  const confirmed =
    journal.failureCount >= CRASH_FAILURES ||
    state.consecutiveUnhealthy >= UNHEALTHY_CONSEC ||
    backOnQuarantined;

  if (!confirmed) {
    // Not yet a confirmed crash-loop — likely a self-update mid-restart or a single transient blip.
    // Do NOT alert or roll back (avoids acting on a normal clean restart).
    writeState(state);
    console.log(`[watchdog] unhealthy but UNCONFIRMED (active=${active}, failures=${journal.failureCount}/${WINDOW_MIN}min, consec=${state.consecutiveUnhealthy}, restartCounter=${journal.restartCounter}) — waiting`);
    return;
  }

  // CONFIRMED crash-loop.
  const failingSha = curSha || state.quarantinedSha || "unknown";
  console.error(`[watchdog] CRASH-LOOP CONFIRMED on ${shortSha(failingSha)} (failures=${journal.failureCount}/${WINDOW_MIN}min, restartCounter=${journal.restartCounter}, consec=${state.consecutiveUnhealthy}, backOnQuarantined=${backOnQuarantined}). Error: ${journal.errorLine || "(none captured)"}`);

  const canRollback = !!state.knownGoodSha && state.knownGoodSha !== failingSha;
  let rollback: { to: string; verified: boolean } | null = null;

  // ROLLBACK FIRST (survival action — must run even if the DB/alert is down).
  if (canRollback) {
    const verified = rollbackTo(state.knownGoodSha as string);
    rollback = { to: state.knownGoodSha as string, verified };
    state.quarantinedSha = failingSha; // re-assert the rollback next tick if the worker re-pulls it
    state.lastRollback = { from: failingSha, to: state.knownGoodSha as string, at: new Date().toISOString(), verified };
    state.consecutiveUnhealthy = 0; // give the fresh boot a clean slate
  } else if (!state.knownGoodSha) {
    console.error("[watchdog] no known-good SHA recorded — cannot auto-rollback. Alerting only.");
  }

  // ALERT (best-effort; de-duped per failing SHA so we page once per bad commit).
  if (admin && state.alertedSha !== failingSha) {
    await writeAlert(admin, failingSha, journal.errorLine, rollback, !state.knownGoodSha);
    state.alertedSha = failingSha;
  } else if (admin && rollback) {
    // Already paged on this SHA, but refresh the alert detail with the rollback outcome.
    await writeAlert(admin, failingSha, journal.errorLine, rollback, false);
  }

  writeState(state);
}

async function main(): Promise<void> {
  if (process.argv.includes("--verify")) runVerifyMode();
  try {
    await tick();
  } catch (e) {
    // The watchdog must never crash silently — log loudly and exit non-zero so a failed
    // tick is visible in its own journal.
    console.error(`[watchdog] tick failed: ${e instanceof Error ? e.stack || e.message : e}`);
    process.exit(1);
  }
}

void main();
