// usage-report — LOCAL Mac reporter for the fleet-usage-cockpit (Phase 2 of
// docs/brain/specs/fleet-usage-cockpit.md). Runs on the founder's Mac only
// (the build box has no filesystem access to ~/.claude / ~/.codex).
//
// Shells out to `npx ccusage@latest blocks --json` twice — once for Claude
// (~/.claude), once for Codex (~/.codex/sessions) — maps each output to
// per-account snapshot payloads, and POSTs the batch to the deployed
// /api/developer/usage/report endpoint with an owner bearer token.
//
// Usage (from the founder's Mac):
//   npx tsx scripts/usage-report.ts
//   USAGE_REPORT_URL=https://shopcx.ai/api/developer/usage/report \
//   USAGE_REPORT_TOKEN=<owner-token> \
//   USAGE_REPORT_WORKSPACE_ID=fdc11e10-b89f-4989-8b73-ed6526c4d906 \
//   npx tsx scripts/usage-report.ts
//
// Idempotent. The route's UNIQUE (workspace_id, source, account, window_kind)
// key means a re-report REPLACES the prior Mac slice instead of duplicating.
//
// Wired via launchd + optional SessionEnd hook — see the recipe:
//   docs/brain/recipes/mac-usage-reporter.md
//
// Never mutates the box's data path — this file is Mac-only. `.env.local` is
// loaded by ./_bootstrap (which is a no-op on the box) so the token/URL/
// workspace id are read from local env, never committed.
import "./_bootstrap";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  mapCcusageToSnapshots,
  MAX_ACCOUNT_LABELS,
  CODEX_ACCOUNT_LABEL,
  type CcusageOutputLike,
  type MacSnapshotInput,
} from "../src/lib/usage-snapshots";

const execFileAsync = promisify(execFile);

const DEFAULT_URL = "https://shopcx.ai/api/developer/usage/report";
const DEFAULT_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function runCcusage(env: NodeJS.ProcessEnv): Promise<CcusageOutputLike | null> {
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["ccusage@latest", "blocks", "--json"],
      { env, maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
    );
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") return parsed as CcusageOutputLike;
    return null;
  } catch (err) {
    console.warn(`[usage-report] ccusage run failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Build the full snapshots batch — for the founder's local Mac we don't have
 * a per-account split (ccusage sees ONE lane per home-dir: the ~/.claude the
 * founder logged into). So we attribute the Claude output to the FIRST Max
 * label ('Round Robin 1') by default — the config-dir label the Mac shells
 * into. Callers can override with USAGE_REPORT_CLAUDE_ACCOUNT.
 */
async function buildBatch(now: number): Promise<MacSnapshotInput[]> {
  const claudeAccount = process.env.USAGE_REPORT_CLAUDE_ACCOUNT || MAX_ACCOUNT_LABELS[0];
  const codexAccount = process.env.USAGE_REPORT_CODEX_ACCOUNT || CODEX_ACCOUNT_LABEL;

  const claudeEnv = { ...process.env, CLAUDE_CONFIG_DIR: process.env.USAGE_REPORT_CLAUDE_HOME || "" };
  const codexEnv = { ...process.env, CODEX_HOME: process.env.USAGE_REPORT_CODEX_HOME || "" };

  const [claudeOut, codexOut] = await Promise.all([runCcusage(claudeEnv), runCcusage(codexEnv)]);

  const snaps: MacSnapshotInput[] = [];
  snaps.push(...mapCcusageToSnapshots(claudeOut, { account: claudeAccount, runtime: "claude", now }));
  snaps.push(...mapCcusageToSnapshots(codexOut, { account: codexAccount, runtime: "codex", now }));
  return snaps;
}

async function postBatch(url: string, token: string, workspaceId: string, snapshots: MacSnapshotInput[]): Promise<{ upserted: number }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ workspace_id: workspaceId, snapshots }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${url} failed: ${res.status} ${text.slice(0, 500)}`);
  }
  return (await res.json()) as { upserted: number };
}

async function main() {
  const url = process.env.USAGE_REPORT_URL || DEFAULT_URL;
  const token = process.env.USAGE_REPORT_TOKEN;
  const workspaceId = process.env.USAGE_REPORT_WORKSPACE_ID || DEFAULT_WORKSPACE_ID;
  if (!token) {
    console.error("[usage-report] USAGE_REPORT_TOKEN not set — abort. See docs/brain/recipes/mac-usage-reporter.md.");
    process.exit(1);
  }

  const now = Date.now();
  const snapshots = await buildBatch(now);
  if (!snapshots.length) {
    console.warn("[usage-report] no snapshots produced (ccusage returned nothing usable) — nothing to POST");
    return;
  }

  console.log(`[usage-report] posting ${snapshots.length} snapshot(s) to ${url}`);
  const { upserted } = await postBatch(url, token, workspaceId, snapshots);
  console.log(`[usage-report] upserted=${upserted}`);
}

main().catch((e) => {
  console.error("[usage-report] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
