/**
 * One-time audit + repair: re-check every historical `ran` `data_op_runs` row whose APPLY-gated
 * script may only have DRY-RUN under the old executor —
 * [[../docs/brain/specs/ship-time-backfill-executor-passes-apply]] Phase 2.
 *
 * Why: before Phase 1, `executeShipTimeBackfillsForSpec` spawned `npx tsx -- <script>` with NO
 * `--apply`, so the 42-of-55 scripts that are dry-run-by-default were marked `ran` after writing
 * NOTHING. ~14 APPLY-gated rows are `ran` this way. They are idempotent, so re-checking is safe:
 * this script DRY-RUNs each one again and parses the output —
 *   - pending work   → reset the row to `pending` (via the ledger's own writer) and re-drain it
 *                      WITH `--apply` through the Phase-1 `executeShipTimeBackfillsForSpec`.
 *   - clean no-op    → the data is already in place → leave the row `ran`.
 *   - ambiguous / dry-run errored / script gone from main / surgical one-customer fix → NOT
 *     auto-re-run (re-applying a one-off refund could double-charge) → listed on ONE CEO approvals
 *     card (`escalateDiagnosisToCeo`, dedupeKey `backfill-reaudit`) so the founder decides.
 *
 * A script with NO apply-gate always wrote on its first run and is left `ran` untouched. The
 * reaudit NEVER audits itself (its own row is `pending` while it runs, and self is skipped anyway).
 *
 * Auto-ledgered by the post-merge [[../src/lib/ship-time-backfill-detector|ship-time-backfill-detector]]
 * (the `scripts/_backfill-*.ts` convention) and drained on the box by
 * `executeShipTimeBackfillsForSpec` in [[../src/lib/ship-time-backfill-executor|ship-time-backfill-executor]].
 *
 * Idempotent: a second run finds the already-reset rows now `pending` (so the status='ran' scan
 * skips them) and the already-applied rows reporting no-op. Dry-run by default; `--apply` writes.
 *
 *   npx tsx scripts/_backfill-reaudit-dry-run-ledger-rows.ts            # dry-run (audit only)
 *   npx tsx scripts/_backfill-reaudit-dry-run-ledger-rows.ts --apply    # flip + re-drain + escalate
 *
 * Spec: docs/brain/specs/ship-time-backfill-executor-passes-apply.md Phase 2.
 */
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { createAdminClient } from "./_bootstrap";
import {
  isValidScriptPathForExec,
  executeShipTimeBackfillsForSpec,
} from "../src/lib/ship-time-backfill-executor";
import { markLedgerRowPendingForReaudit } from "../src/lib/ship-time-backfill-detector";
import {
  scriptHasApplyGate,
  classifyReauditDryRun,
  REAUDIT_DEDUPE_KEY,
  REAUDIT_ESCALATION_KIND,
} from "../src/lib/ship-time-backfill-reaudit";
import { escalateDiagnosisToCeo } from "../src/lib/agents/platform-director";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";

/** This script's own repo-relative path — never audit self (would recurse). */
const SELF_PATH = "scripts/_backfill-reaudit-dry-run-ledger-rows.ts";

/** Deep link the escalation card points at (same roadmap surface the detector uses). */
const DEEP_LINK = "/dashboard/roadmap";

/** Per-script dry-run deadline — a hung dry run is killed and treated as ambiguous (escalate). */
const DRY_RUN_TIMEOUT_MS = 2 * 60_000;

type RanRow = {
  id: string;
  workspace_id: string;
  spec_slug: string | null;
  script_path: string;
};

interface DryRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `npx tsx -- <script>` in DRY-RUN mode — array argv (never a shell string) with a `--`
 * separator, and `APPLY` explicitly STRIPPED from the child env (the box runs this script via the
 * executor WITH `APPLY=1`, which the child would otherwise inherit and WRITE). Never throws.
 */
function spawnDryRun(repoDir: string, scriptPath: string): Promise<DryRunResult> {
  return new Promise<DryRunResult>((res) => {
    const childEnv = { ...process.env };
    delete childEnv.APPLY; // force dry-run even though OUR env may carry APPLY=1
    const child = spawn("npx", ["tsx", "--", scriptPath], {
      cwd: repoDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* best-effort */
      }
      res({ code: null, stdout, stderr: `${stderr}\n[timed out after ${DRY_RUN_TIMEOUT_MS}ms]` });
    }, DRY_RUN_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < 20_000) stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 8_000) stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ code: null, stdout, stderr: `${stderr}\nspawn failed: ${err.message}` });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
}

/** One escalation line: a row we refuse to auto-re-run, with the reason + a short dry-run summary. */
interface EscalationItem {
  scriptPath: string;
  specSlug: string | null;
  reason: string;
  summary: string;
}

(async () => {
  const repoDir = process.cwd();
  const admin = createAdminClient();
  console.log(`reaudit_dry_run_ledger_rows_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`);

  const { data, error } = await admin
    .from("data_op_runs")
    .select("id, workspace_id, spec_slug, script_path")
    .eq("status", "ran");
  if (error) throw new Error(`data_op_runs read failed: ${error.message}`);
  const rows = ((data ?? []) as RanRow[]).filter((r) => r.script_path !== SELF_PATH);
  console.log(`  scanning ${rows.length} ran row(s)\n`);

  let noop = 0;
  let flipped = 0;
  let wouldFlip = 0;
  let skippedAlwaysWrites = 0;
  // Reset rows grouped by (workspace_id, spec_slug) so the Phase-1 executor can re-drain each spec.
  const toDrain = new Map<string, { workspaceId: string; specSlug: string }>();
  // Escalations grouped by workspace so one CEO card per workspace carries all its undecidable rows.
  const escalationsByWorkspace = new Map<string, EscalationItem[]>();
  const pushEscalation = (workspaceId: string, item: EscalationItem) => {
    const list = escalationsByWorkspace.get(workspaceId) ?? [];
    list.push(item);
    escalationsByWorkspace.set(workspaceId, list);
    console.log(`  escalate   ${item.scriptPath} — ${item.reason}`);
  };

  for (const row of rows) {
    const abs = resolve(repoDir, row.script_path);
    // Capability boundary — script_path is a spec-authored field; validate before ANY spawn.
    if (!isValidScriptPathForExec(row.script_path)) {
      pushEscalation(row.workspace_id, {
        scriptPath: row.script_path,
        specSlug: row.spec_slug,
        reason: "invalid script_path (failed capability validation)",
        summary: "not a valid scripts/_backfill-*.ts path — not spawned",
      });
      continue;
    }
    // Script gone from main → cannot re-check; founder decides.
    if (!existsSync(abs)) {
      pushEscalation(row.workspace_id, {
        scriptPath: row.script_path,
        specSlug: row.spec_slug,
        reason: "script no longer exists on main",
        summary: "file missing in the working tree — cannot dry-run",
      });
      continue;
    }
    // No apply-gate → the script always writes → it DID write on its first run → leave `ran`.
    let source = "";
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      source = "";
    }
    if (!scriptHasApplyGate(source)) {
      skippedAlwaysWrites += 1;
      console.log(`  skip       ${row.script_path} — no --apply gate (always writes; left ran)`);
      continue;
    }
    // Re-check: dry-run and classify.
    const dry = await spawnDryRun(repoDir, row.script_path);
    const tail = (dry.stdout || dry.stderr || "").trim().slice(-400);
    if (dry.code !== 0) {
      pushEscalation(row.workspace_id, {
        scriptPath: row.script_path,
        specSlug: row.spec_slug,
        reason: `dry-run exited ${dry.code === null ? "abnormally" : dry.code}`,
        summary: tail || "(no output)",
      });
      continue;
    }
    const verdict = classifyReauditDryRun(dry.stdout);
    if (verdict === "noop") {
      noop += 1;
      console.log(`  no-op      ${row.script_path} — already applied (left ran)`);
      continue;
    }
    if (verdict === "ambiguous") {
      pushEscalation(row.workspace_id, {
        scriptPath: row.script_path,
        specSlug: row.spec_slug,
        reason: "ambiguous dry-run (no clean no-op or would-write count)",
        summary: tail || "(no output)",
      });
      continue;
    }
    // verdict === "pending" → reset to pending + queue its spec for re-drain.
    if (!APPLY) {
      wouldFlip += 1;
      console.log(`  would-flip ${row.script_path} — dry-run reports pending work`);
      continue;
    }
    const note = `reaudit ${new Date().toISOString().slice(0, 10)}: dry-run still reports pending work after Phase-1 --apply fix; reset to pending for re-drain`;
    const ok = await markLedgerRowPendingForReaudit(admin, {
      id: row.id,
      workspaceId: row.workspace_id,
      note,
    });
    if (ok) {
      flipped += 1;
      console.log(`  flipped    ${row.script_path} — reset ran → pending`);
      if (row.spec_slug) {
        toDrain.set(`${row.workspace_id}::${row.spec_slug}`, {
          workspaceId: row.workspace_id,
          specSlug: row.spec_slug,
        });
      }
    } else {
      console.log(`  raced      ${row.script_path} — already advanced by another pass`);
    }
  }

  // ── Re-drain every reset row through the Phase-1 executor (passes --apply + dry-run guard). ──
  let drainedRan = 0;
  let drainedFailed = 0;
  if (APPLY && toDrain.size > 0) {
    console.log(`\n  re-draining ${toDrain.size} spec(s) with --apply …`);
    for (const { workspaceId, specSlug } of toDrain.values()) {
      const summary = await executeShipTimeBackfillsForSpec({ workspaceId, specSlug, repoDir });
      drainedRan += summary.ran;
      drainedFailed += summary.failed;
      console.log(
        `    ${specSlug}: pending=${summary.pending} ran=${summary.ran} failed=${summary.failed} raced=${summary.raced}`,
      );
    }
  }

  // ── One CEO approvals card per workspace listing the rows we refused to auto-re-run. ──
  let escalated = 0;
  if (APPLY) {
    for (const [workspaceId, items] of escalationsByWorkspace) {
      const diagnosis =
        `Re-audit of historical \`ran\` ship-time backfills (Phase 2) found ${items.length} row(s) that CANNOT be ` +
        `safely auto-re-run — a missing script, an ambiguous dry run, or a surgical one-customer fix. ` +
        `Decide per row whether to run it (\`npx tsx <script> --apply\`) or mark it settled.\n\n` +
        items
          .map((i) => `• ${i.scriptPath}${i.specSlug ? ` (spec: ${i.specSlug})` : ""}\n    reason: ${i.reason}\n    dry-run: ${i.summary.replace(/\n/g, " ").slice(0, 240)}`)
          .join("\n\n");
      const ceo = await escalateDiagnosisToCeo(admin, {
        workspaceId,
        specSlug: null,
        title: `Ship-time backfill re-audit: ${items.length} row(s) need a human call`,
        diagnosis,
        dedupeKey: REAUDIT_DEDUPE_KEY,
        deepLink: DEEP_LINK,
        escalationKind: REAUDIT_ESCALATION_KIND,
        metadata: {
          routed_to_function: "ceo",
          escalated_by_director: "platform",
          count: items.length,
          scripts: items.map((i) => i.scriptPath),
        },
      });
      if (ceo.emitted || ceo.bumped) escalated += 1;
    }
  }

  console.log("");
  if (APPLY) {
    console.log(
      `result: scanned=${rows.length} no-op=${noop} flipped=${flipped} ` +
        `skipped-always-writes=${skippedAlwaysWrites} re-drained(ran=${drainedRan} failed=${drainedFailed}) ` +
        `escalated-cards=${escalated}`,
    );
  } else {
    const wouldEscalate = [...escalationsByWorkspace.values()].reduce((n, l) => n + l.length, 0);
    console.log(
      `result: scanned=${rows.length} no-op=${noop} would-flip=${wouldFlip} ` +
        `skipped-always-writes=${skippedAlwaysWrites} would-escalate=${wouldEscalate} ` +
        `(dry-run — re-run with --apply to write)`,
    );
  }
})().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
