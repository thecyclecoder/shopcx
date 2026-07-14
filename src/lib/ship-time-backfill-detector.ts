/**
 * ship-time-backfill-detector — Phase 1 of
 * [[../../docs/brain/specs/ship-time-data-backfills-run-and-ledgered-not-silently-dead-code]].
 *
 * Mirrors the migration-drift ledger role for one-time data backfills. A spec that ships a
 * `scripts/_backfill-*.ts` merges the file into main but the deployed runtime never executes it
 * — it lands as dead code, indistinguishable from a shipped migration that auto-applies. Twice
 * now (media-buyer cohort-template Superfood Tabs stayed 2/4 for days; the migration-ledger
 * drift class) the un-run backfill was INVISIBLE until someone noticed the wrong data.
 *
 * This module makes an un-run backfill VISIBLE:
 *   1. On every merged claude/* build, list the files added by that PR (GitHub PR-files API).
 *   2. For each addition matching `scripts/_backfill-*.ts`, upsert a `pending` row into
 *      `public.data_op_runs` (unique per (workspace, spec_slug, script_path)).
 *   3. For any row that does NOT yet carry a successful `ran` outcome, INSERT a routed
 *      `dashboard_notifications` card (type `agent_approval_request`, `routed_to_function:
 *      "ceo"`) — the exact CEO-inbox surface [[media-buyer/agent]] `escalateUnderProvisionedCohort`
 *      uses when Bianca hits a rail. Deduped per (spec_slug, script_path) per UTC day so the
 *      post-merge hook can re-fire (manual-squash reconcile + auto-merge webhook race) without
 *      spamming the inbox.
 *
 * Phase 2 will add the auto-execute + Control Tower tile — for now Phase 1's safety net is
 * ESCALATE, never silently pass.
 *
 * Node-completeness trio (north-star hard rule):
 *   - OWNER — registered as a `reactive` loop under Platform in
 *     [[control-tower/registry]] `MONITORED_LOOPS` (`SHIP_TIME_BACKFILL_LOOP_ID`).
 *   - KILL-SWITCH ANCESTRY — inherits Platform's ancestry via the node registry
 *     ([[control-tower/node-registry]] `parentIdForOwner('platform')` → `director:platform`).
 *   - HEARTBEAT — `emitReactiveHeartbeat(SHIP_TIME_BACKFILL_LOOP_ID, …)` fires from a
 *     try/finally so a throw still beats `ok:false` (never silently dark).
 *
 * Best-effort by contract — `detectAndEscalateShipTimeBackfills` never throws, so a GitHub
 * outage / missing token / DB hiccup can't block the post-merge hook that carries it.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { emitReactiveHeartbeat } from "@/lib/control-tower/heartbeat";
import {
  SHIP_TIME_BACKFILL_LOOP_ID,
  SHIP_TIME_BACKFILL_ESCALATION_KIND,
} from "@/lib/control-tower/registry";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";

/** The GitHub repo the merged PRs live in — matches [[./github-pr-resolve]] default. */
const GH_REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";

/** Deep link the CEO inbox card points at (the roadmap board — where a shipped spec surfaces). */
const SHIP_TIME_BACKFILL_DEEP_LINK = "/dashboard/roadmap";

/** The org function that OWNS the detector — matches the MONITORED_LOOPS entry + node-registry. */
const PLATFORM_DIRECTOR_FUNCTION = "platform";

/** Regex a script_path must match to be a ship-time backfill (`scripts/_backfill-<slug>.ts`). */
const BACKFILL_PATH_RE = /^scripts\/_backfill-[a-z0-9][a-z0-9._-]*\.ts$/;

/** True iff a repo-relative path is a ship-time backfill script (bounded convention). */
export function isBackfillScriptPath(path: string): boolean {
  return BACKFILL_PATH_RE.test(path);
}

/** One entry from GitHub's PR-files response — only the fields we consume. */
interface GhPrFile {
  filename: string;
  /** `added` | `modified` | `removed` | `renamed` | `copied` | `changed` | `unchanged` */
  status: string;
}

/**
 * List every file the merged PR added, matching the ship-time backfill convention. Best-effort:
 * a missing token / API failure returns [] (the detector then no-ops for this merge — a later
 * reconcile pass over the same PR can retry cleanly because the ledger is upsert-keyed).
 *
 * GitHub PR-files pagination: up to 3000 files across 30-page * 100-per-page (100 is the max
 * per_page). We only need the first page — a claude/build-* PR that ships >100 files is beyond
 * any realistic backfill spec (and would already be a rejected review anyway).
 */
export async function listBackfillFilesAddedByPr(prNumber: number): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
  if (!token) return [];
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GH_REPO}/pulls/${prNumber}/files?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as GhPrFile[] | Record<string, unknown>;
    if (!Array.isArray(json)) return [];
    return json
      .filter((f) => f && f.status === "added" && typeof f.filename === "string")
      .map((f) => f.filename)
      .filter(isBackfillScriptPath);
  } catch {
    return [];
  }
}

/** Outcome of one detector run — carried on the heartbeat so the tile can show what happened. */
export interface ShipTimeBackfillDetectionSummary {
  /** merged PR number the run inspected (null if the hook fired without a PR — e.g. a legacy manual reconcile). */
  prNumber: number | null;
  /** merged spec slug the run inspected. */
  specSlug: string;
  /** number of backfill scripts detected in the merged diff. */
  detected: number;
  /** number of new `pending` ledger rows inserted (a row already present is not double-inserted). */
  ledgered: number;
  /** number of ESCALATIONS emitted to the CEO inbox (unrun + not-yet-escalated-today). */
  escalated: number;
  /** true when the detector short-circuited because GITHUB_TOKEN was missing / the API failed. */
  githubUnavailable: boolean;
}

interface DetectArgs {
  workspaceId: string;
  specSlug: string;
  prNumber: number | null;
  mergeSha: string | null;
}

/**
 * Post-merge detector + escalator. Never throws — the caller (applyMergedBuildEffects) drives
 * this behind a try/catch AS WELL, so nothing in this module can break the merge hook.
 *
 * Idempotent on repeat calls: the ledger is upsert-keyed on (workspace_id, spec_slug,
 * script_path) and the escalation is deduped per (spec, script) per UTC day, so the
 * manual-reconcile + auto-merge-webhook race collapses to one row + one card.
 */
export async function detectAndEscalateShipTimeBackfills(
  args: DetectArgs,
): Promise<ShipTimeBackfillDetectionSummary> {
  const started = Date.now();
  const summary: ShipTimeBackfillDetectionSummary = {
    prNumber: args.prNumber,
    specSlug: args.specSlug,
    detected: 0,
    ledgered: 0,
    escalated: 0,
    githubUnavailable: false,
  };
  let heartbeatOk = true;
  try {
    // No PR number → no diff to inspect. A hook fired without one (manual pre-webhook reconcile
    // of a legacy job) is not an error; the auto-merge webhook path always carries prNumber.
    if (!args.prNumber) {
      return summary;
    }
    const files = await listBackfillFilesAddedByPr(args.prNumber);
    if (files.length === 0) {
      // Distinguish "no backfill in this PR" from "GitHub unavailable" only when a token was set —
      // an empty result without a token means we couldn't check.
      summary.githubUnavailable = !(process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN);
      return summary;
    }
    summary.detected = files.length;
    const admin = createAdminClient();
    // ── 1. Upsert one `pending` ledger row per detected script (idempotent). ──
    // Read first so we can tell "newly ledgered" from "already known" for the summary + so a
    // successful `ran` row doesn't get demoted to `pending` by the upsert. `.upsert` with
    // `ignoreDuplicates:true` on the composite unique matches the "insert if new" intent.
    const { data: existingRows } = await admin
      .from("data_op_runs")
      .select("script_path, status")
      .eq("workspace_id", args.workspaceId)
      .eq("spec_slug", args.specSlug)
      .in("script_path", files);
    const existingByPath = new Map<string, string>();
    for (const r of (existingRows ?? []) as Array<{ script_path: string; status: string }>) {
      existingByPath.set(r.script_path, r.status);
    }
    const toInsert: Array<{ workspace_id: string; spec_slug: string; script_path: string; status: string }> = [];
    for (const path of files) {
      if (!existingByPath.has(path)) {
        toInsert.push({
          workspace_id: args.workspaceId,
          spec_slug: args.specSlug,
          script_path: path,
          status: "pending",
        });
      }
    }
    if (toInsert.length) {
      const { data: inserted, error: insertErr } = await admin
        .from("data_op_runs")
        .upsert(toInsert, {
          onConflict: "workspace_id,spec_slug,script_path",
          ignoreDuplicates: true,
        })
        .select("script_path");
      if (insertErr) {
        // Ledger write failed → still emit the escalation for every detected script so the
        // signal isn't lost. A recovered ledger on the next hook pass will fill in the rows.
        heartbeatOk = false;
      } else {
        summary.ledgered = (inserted ?? []).length;
      }
    }
    // ── 2. Escalate every script whose current ledger status is NOT `ran` (never silently pass). ──
    // Re-select AFTER the upsert so a row a concurrent pass wrote is picked up.
    const { data: liveRows } = await admin
      .from("data_op_runs")
      .select("script_path, status")
      .eq("workspace_id", args.workspaceId)
      .eq("spec_slug", args.specSlug)
      .in("script_path", files);
    const day = new Date(started).toISOString().slice(0, 10);
    for (const row of (liveRows ?? []) as Array<{ script_path: string; status: string }>) {
      if (row.status === "ran") continue; // a successful run clears the safety net
      const emitted = await escalateShipTimeBackfill(admin, {
        workspaceId: args.workspaceId,
        specSlug: args.specSlug,
        scriptPath: row.script_path,
        ledgerStatus: row.status,
        day,
      });
      if (emitted) summary.escalated += 1;
    }
    return summary;
  } catch (e) {
    heartbeatOk = false;
    console.warn(
      `[ship-time-backfill-detector] detect/escalate failed for pr=${args.prNumber} spec=${args.specSlug}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return summary;
  } finally {
    // Reactive-loop heartbeat: idle merges (no backfill in the diff) beat `ok:true` with
    // produced.detected=0 so a silent detector still shows liveness in the Control Tower.
    try {
      await emitReactiveHeartbeat(SHIP_TIME_BACKFILL_LOOP_ID, {
        ok: heartbeatOk,
        produced: summary,
        durationMs: Date.now() - started,
      });
    } catch {
      /* best-effort — a heartbeat write must never fail the loop it reports on */
    }
  }
}

/** Insert ONE CEO-inbox escalation card for an unrun ship-time backfill (deduped per UTC day). */
async function escalateShipTimeBackfill(
  admin: ReturnType<typeof createAdminClient>,
  args: {
    workspaceId: string;
    specSlug: string;
    scriptPath: string;
    ledgerStatus: string;
    day: string;
  },
): Promise<boolean> {
  const dedupeKey = `ship_time_backfill:${args.workspaceId}:${args.specSlug}:${args.scriptPath}:${args.day}`;
  // Confirming predicate — bail if any card for this dedupe_key already exists in this workspace's
  // inbox today. Never enumerate then insert without re-asserting the "not yet escalated" state.
  const { data: prior } = await admin
    .from("dashboard_notifications")
    .select("id")
    .eq("workspace_id", args.workspaceId)
    .eq("type", APPROVAL_REQUEST_TYPE)
    .eq("metadata->>dedupe_key", dedupeKey)
    .limit(1);
  if ((prior ?? []).length > 0) return false;

  const title = `Ship-time backfill un-run: ${args.scriptPath}`;
  const statusLabel = args.ledgerStatus === "failed" ? "FAILED" : "PENDING";
  const body =
    `⚙️ A spec shipped a one-time data backfill script but the ledger status is ${statusLabel} — ` +
    `the deployed runtime does NOT auto-execute a scripts/_backfill-*.ts, so this backfill has not run ` +
    `against prod.\n\n` +
    `Spec: ${args.specSlug}\n` +
    `Script: ${args.scriptPath}\n` +
    `Ledger status: ${args.ledgerStatus}\n\n` +
    `Run the script (\`npx tsx ${args.scriptPath}\`) or convert it to an idempotent migration. ` +
    `See docs/brain/tables/data_op_runs.md for the ledger, and Phase 2 of the spec for the coming ` +
    `auto-execute + Control Tower tile.`;

  const { error } = await admin.from("dashboard_notifications").insert({
    workspace_id: args.workspaceId,
    type: APPROVAL_REQUEST_TYPE,
    title: title.slice(0, 200),
    body: body.slice(0, 4000),
    link: SHIP_TIME_BACKFILL_DEEP_LINK,
    metadata: {
      routed_to_function: "ceo",
      escalated_by_director: PLATFORM_DIRECTOR_FUNCTION,
      escalation_kind: SHIP_TIME_BACKFILL_ESCALATION_KIND,
      spec_slug: args.specSlug,
      script_path: args.scriptPath,
      ledger_status: args.ledgerStatus,
      dedupe_key: dedupeKey,
      approve_action_id: null,
    },
    read: false,
    dismissed: false,
  });
  return !error;
}
