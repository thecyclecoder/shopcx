/**
 * Mario→Ada escalation: reclaim the stuck built-but-unmerged spec
 * [[sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend]].
 *
 * WHY this needs a script:
 *  Mario's `reclaim_and_redrive` action would normally handle this class (enqueue a
 *  fresh build via `queueRoadmapBuild`), but its previous invocation was silently
 *  coalesced by `queueRoadmapBuild`'s existing-job guard
 *  (src/lib/roadmap-actions.ts:170-173) which has NO `kind` filter — the running
 *  Mario job itself matched the `spec_slug` + `ACTIVE_STATUSES` predicate, the
 *  guard returned `alreadyActive:true`, and nothing was enqueued. Also the correct
 *  immediate action for a terminal `failed` build is to flip failed→queued, which
 *  is outside Mario's non-destructive vocabulary (redrive/unstick need
 *  `building`/`claimed`; `requeue_unclaimed_job` needs `queued`). So Ada owns it.
 *
 * WHAT this script does (dry-run by default, `--apply` to write):
 *  1. Locate the LATEST `kind='build'` `agent_jobs` row for
 *     `spec_slug='sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend'`
 *     in the sanctioned workspace.
 *  2. Verify it is genuinely stuck: `status='failed'`, non-null `error` mentioning
 *     the worktree collision, no newer non-terminal build row for the same slug.
 *  3. Flip that row to `status='queued'` (compare-and-set on id + workspace +
 *     current status='failed'), clear the `claimed_at` / `claude_session_id` /
 *     `log_tail` so a fresh worker claims it cleanly, and stash the prior
 *     `error` on `log_tail` for audit.
 *  4. Record a `director_activity` row (`director_function='platform'`,
 *     `actionKind='ada_reclaim_failed_build'`) so the reclaim is auditable.
 *
 * FAIL-CLOSED: refuses to flip anything if:
 *  - No matching failed build found (already reclaimed / different state).
 *  - A NEWER non-terminal build row exists for the same slug (someone already
 *    requeued — coalescing risk resolved).
 *  - The failed row's `error` doesn't look like the worktree collision (guard
 *    against flipping an unrelated failure).
 *
 * Idempotent: re-running after a successful flip is a no-op (the row is no
 * longer `failed`).
 */
import { loadEnv, createAdminClient } from "./_bootstrap";
loadEnv();
import { recordDirectorActivity } from "../src/lib/director-activity";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SPEC_SLUG = "sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend";
const WORKTREE_COLLISION_MARKER = "sol-reads-moved-wt";

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  // 1. Find the newest kind='build' row for this spec_slug in the workspace.
  const { data: newestBuild, error: readErr } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, spec_slug, spec_branch, kind, status, claimed_at, claude_session_id, error, log_tail, created_at, updated_at")
    .eq("workspace_id", WS)
    .eq("spec_slug", SPEC_SLUG)
    .eq("kind", "build")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (readErr) {
    console.error("READ failed:", readErr.message);
    process.exit(2);
  }
  if (!newestBuild) {
    console.log("No kind='build' row exists for this spec — nothing to reclaim.");
    process.exit(0);
  }
  const row = newestBuild as {
    id: string;
    workspace_id: string;
    spec_slug: string;
    spec_branch: string | null;
    kind: string;
    status: string;
    claimed_at: string | null;
    claude_session_id: string | null;
    error: string | null;
    log_tail: string | null;
    created_at: string;
    updated_at: string;
  };
  console.log(`Newest build row: id=${row.id} status=${row.status} branch=${row.spec_branch ?? "<none>"} created_at=${row.created_at}`);
  if (row.error) console.log(`  error snippet: ${row.error.slice(0, 200)}`);

  if (row.status !== "failed") {
    console.log(`Row is not 'failed' (status=${row.status}). Nothing to reclaim — likely already unstuck.`);
    process.exit(0);
  }

  // 2. Guard: refuse to flip if the error doesn't look like the worktree collision.
  const errText = (row.error ?? "").toLowerCase() + " " + (row.log_tail ?? "").toLowerCase();
  const looksLikeWorktreeCollision =
    errText.includes(WORKTREE_COLLISION_MARKER) ||
    errText.includes("worktree add") ||
    errText.includes("already exists") ||
    errText.includes("/tmp/") && errText.includes("wt");
  if (!looksLikeWorktreeCollision) {
    console.error("REFUSING to flip: the failed row's error does not look like the worktree collision this reclaim targets.");
    console.error(`  error: ${row.error?.slice(0, 300)}`);
    process.exit(3);
  }

  // 3. Guard: refuse if a newer non-terminal build row exists (someone already requeued).
  const ACTIVE_STATUSES = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume", "blocked_on_usage"];
  const { data: newerActive } = await admin
    .from("agent_jobs")
    .select("id, status, created_at")
    .eq("workspace_id", WS)
    .eq("spec_slug", SPEC_SLUG)
    .eq("kind", "build")
    .in("status", ACTIVE_STATUSES)
    .gt("created_at", row.created_at)
    .limit(1)
    .maybeSingle();
  if (newerActive) {
    const na = newerActive as { id: string; status: string; created_at: string };
    console.log(`A newer active build row already exists (id=${na.id} status=${na.status}). No flip needed.`);
    process.exit(0);
  }

  // 4. Ready to flip.
  const priorError = row.error ?? "";
  const priorLogTail = row.log_tail ?? "";
  const auditLine = `[ada reclaim ${new Date().toISOString()}] Flipping build ${row.id} from failed→queued after Mario reclaim_and_redrive was coalesced by queueRoadmapBuild's kind-less guard. Prior error: ${priorError.slice(0, 500)}`;

  if (!apply) {
    console.log("\nDRY RUN. Would UPDATE agent_jobs SET");
    console.log("  status = 'queued'");
    console.log("  claimed_at = NULL");
    console.log("  claude_session_id = NULL");
    console.log("  error = NULL");
    console.log(`  log_tail = <appended audit line>`);
    console.log(`WHERE id = '${row.id}' AND workspace_id = '${WS}' AND status = 'failed';`);
    console.log("\nAND would insert one director_activity row (director_function='platform', actionKind='ada_reclaim_failed_build').");
    console.log("\nRe-run with --apply to write.");
    process.exit(0);
  }

  const { data: updated, error: upErr } = await admin
    .from("agent_jobs")
    .update({
      status: "queued",
      claimed_at: null,
      claude_session_id: null,
      error: null,
      log_tail: [priorLogTail, auditLine].filter(Boolean).join("\n").slice(-8000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("workspace_id", WS)
    .eq("status", "failed")
    .select("id");
  if (upErr) {
    console.error("UPDATE failed:", upErr.message);
    process.exit(2);
  }
  if (!updated || updated.length !== 1) {
    console.error("UPDATE affected 0 rows — race lost (row changed under us). Re-run to re-check state.");
    process.exit(4);
  }

  await recordDirectorActivity(admin, {
    workspaceId: WS,
    directorFunction: "platform",
    actionKind: "ada_reclaim_failed_build",
    specSlug: SPEC_SLUG,
    reason: `Reclaimed the stuck built-but-unmerged sol-reads-moved build (Mario reclaim_and_redrive was coalesced by queueRoadmapBuild's kind-less guard — see [[../specs/fix-queue-roadmap-build-kind-filter]] for the durable fix). Flipped failed→queued; the fresh claim rebuilds on a clean worktree.`,
    metadata: {
      actor: "ada",
      job_id: row.id,
      spec_branch: row.spec_branch,
      prior_status: "failed",
      new_status: "queued",
      prior_error_snippet: priorError.slice(0, 500),
    },
  });

  console.log(`Flipped build ${row.id} to 'queued'. director_activity recorded.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
