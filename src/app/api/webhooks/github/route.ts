import { NextResponse, after } from "next/server";
import { verifyGithubWebhook, detectAndEnqueueDirtyPrs, autoMergeReadyPrs } from "@/lib/github-pr-resolve";
import { promoteEligibleSpecsToGoalBranch, promoteCompleteGoalsToMain, enqueuePreMergeFromDeploymentReady } from "@/lib/agent-jobs";

/**
 * GitHub webhook → Dirty-PR Resolver Agent trigger (docs/brain/specs/dirty-pr-resolver-agent.md).
 *
 * GitHub POSTs here on:
 *   - `push` to `main` — the event that *makes* other open PRs conflict.
 *   - `pull_request` opened/synchronize/reopened/ready_for_review.
 *   - `check_suite` / `check_run` completed + `status` — a build PR's checks just went green (the event
 *      that makes a PR READY to auto-merge). Needed only by Gate A below.
 * On either, we run FOUR mirror gates over the open `claude/*` PRs:
 *   1. Dirty-PR resolver (CONFLICTING half): list, check each `mergeable` (GitHub recomputes it async
 *      after a push, so a null is polled briefly), and enqueue ONE deduped `pr-resolve` agent_jobs row for
 *      any that just became CONFLICTING. The box worker (`runPrResolveJob`) then merges origin/main,
 *      resolves the (usually additive) conflicts, tsc-gates, and pushes — or rebuilds-on-main / surfaces.
 *   2. Auto-merge gate (READY half — auto-ship-pipeline Phase 1 / Gate A): squash-merge + delete branch
 *      ONE ready (mergeable + all-checks-green) claude/* PR — serialized, sync-aware, owner kill-switch.
 *   3. Gate B — spec→goal-branch integration (spec-goal-branch-pm-flow M4).
 *   4. Gate C — atomic goal→main promotion (spec-goal-branch-pm-flow M5).
 *
 * HMAC verification (X-Hub-Signature-256, secret = GITHUB_WEBHOOK_SECRET) runs first on the raw body —
 * without it anyone who learns the URL could spoof a build-queue enqueue or an auto-merge. A `ping` is
 * acked. No workspace lookup: the repo serves one build console (the job attaches to the build-console
 * workspace, whose `auto_merge_enabled` flag is the Gate A kill-switch).
 *
 * ACK-fast + bounded-after() pattern. Each of the four gates lists every open `claude/*` PR and makes
 * per-candidate GitHub REST calls (fetch mergeable, per-member spec-eligibility, /merges). On a busy
 * build board the combined work used to exceed Vercel's 300s Lambda cap in the response path, killing
 * the delivery mid-fanout and re-feeding the Runtime Timeout as a level=error log back through the log
 * drain. We now ACK GitHub with `{ ok: true, deferred: true }` the moment the event passes the HMAC +
 * ping + relevance checks (GitHub only needs the ACK — it redelivers on failure), and run the four gates
 * inside `after()`. `after()` still runs on the SAME Lambda invocation (so it counts against the 300s
 * cap), so the loop is wall-clock-bounded to 250s — 50s under the cap — with a warn on trip. Any gate
 * deferred by the deadline is a no-op for this invocation; the next GitHub event (or the box worker's
 * platform-director standing pass, which already re-runs these same gates) picks it up. This is the same
 * shape already load-bearing on `/api/webhooks/vercel-logs`; both webhooks share one bounded-fanout
 * pattern and one place to reason about the Vercel cap.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-hub-signature-256");
  const event = request.headers.get("x-github-event") || "";

  if (!verifyGithubWebhook(rawBody, signatureHeader, process.env.GITHUB_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // GitHub sends a `ping` when the webhook is first configured.
  if (event === "ping") return NextResponse.json({ ok: true, pong: true });

  const action = String(payload.action || "");

  // Gate 1 (dirty-PR resolver) relevance: a push to main (moves the base every other PR merges against) or
  // a PR open/sync/reopen/ready — the events that can make a PR CONFLICTING.
  const dirtyRelevant =
    (event === "push" && payload.ref === "refs/heads/main") ||
    (event === "pull_request" && ["opened", "synchronize", "reopened", "ready_for_review"].includes(action));

  // Gate 2 (auto-merge) relevance: the above PLUS the events that flip a PR to READY — its checks completing
  // (check_suite/check_run completed) or a successful commit status. (A push to main also re-checks: a PR
  // that was behind/blocked may now be clean.)
  const mergeRelevant =
    dirtyRelevant ||
    ((event === "check_suite" || event === "check_run") && action === "completed") ||
    (event === "status" && payload.state === "success");

  // Gate D (preview-ready-event-trigger) relevance: a Vercel PREVIEW deploy just reached READY. GitHub
  // relays this as `deployment_status` with state='success' — the event-driven signal that a build's
  // preview is testable, so the fused Vera/Vault pre-merge session can fire NOW (not on the box's next
  // standing pass). enqueuePreMergeFromDeploymentReady filters to claude/build-* previews.
  const deployReady =
    event === "deployment_status" &&
    (payload.deployment_status as Record<string, unknown> | undefined)?.state === "success";

  if (!dirtyRelevant && !mergeRelevant && !deployReady) return NextResponse.json({ ok: true, skipped: event });

  // ACK GitHub immediately; run the four heavy gates inside after() so the response path can't hit the
  // 300s Vercel Lambda cap. Wall-clock deadline (250_000 ms) inside the callback bounds the total
  // fan-out; any gate deferred by the deadline is picked up by the next event or the box worker's
  // standing pass. Each gate keeps its own try/catch so a failure in one still lets the others run
  // (the existing "independent gates" semantics). Mirror of /api/webhooks/vercel-logs.
  after(async () => {
    const started = Date.now();
    const TOTAL_GATES = 4;
    let ranGates = 0;
    const remaining = () => TOTAL_GATES - ranGates;
    const deadlineHit = () => Date.now() - started > 250_000;

    // Gate D — ⚡ event-driven pre-merge trigger (preview-ready-event-trigger). A Vercel PREVIEW deploy
    // reached READY: map the deploy's commit SHA → its claude/build-* branch → persist the preview URL +
    // fire the fused Vera/Vault pre-merge session NOW. Independent of the four PR gates below (a
    // deployment_status event is neither dirty- nor merge-relevant, so those no-op for it). The
    // standing-pass backstop stays as the safety net for a dropped delivery.
    if (deployReady) {
      try {
        const ds = payload.deployment_status as Record<string, unknown> | undefined;
        const dep = payload.deployment as Record<string, unknown> | undefined;
        const r = await enqueuePreMergeFromDeploymentReady({
          sha: (dep?.sha as string) ?? null,
          previewUrl: (ds?.environment_url as string) || (ds?.target_url as string) || null,
          environment: (ds?.environment as string) ?? (dep?.environment as string) ?? null,
        });
        console.log(
          `[github-webhook] deployment_status READY: pre-merge ${r.enqueued ? "ENQUEUED" : "skipped"}${r.slug ? ` [${r.slug}]` : ""}${r.branch ? ` (${r.branch})` : ""}${r.reason ? ` — ${r.reason}` : ""}`,
        );
      } catch (err) {
        console.error("[github-webhook] deployment-ready trigger failed:", err);
      }
      return; // deployment_status carries none of the PR-gate signals — nothing else to run.
    }

    // Gate 1 — dirty-PR resolver (CONFLICTING half). dirtyRelevant only.
    if (deadlineHit()) {
      console.warn("[github-webhook] after() deadline hit, deferring %d gate(s)", remaining());
      return;
    }
    if (dirtyRelevant) {
      try {
        const dirty = await detectAndEnqueueDirtyPrs();
        console.log(
          `[github-webhook] ${event}: checked ${dirty.checked} claude/* PR(s), ${dirty.conflicting} conflicting, ${dirty.enqueued} pr-resolve job(s) enqueued, ${dirty.closedDuplicate} closed as already-merged duplicate(s)`,
        );
      } catch (err) {
        console.error("[github-webhook] dirty-PR detection failed:", err);
      }
    }
    ranGates++;

    // Gate A — auto-merge ready PRs (serialized, sync-aware, kill-switched).
    if (deadlineHit()) {
      console.warn("[github-webhook] after() deadline hit, deferring %d gate(s)", remaining());
      return;
    }
    if (mergeRelevant) {
      try {
        const autoMerge = await autoMergeReadyPrs();
        console.log(
          `[github-webhook] ${event}: auto-merge ${autoMerge.enabled ? (autoMerge.syncActive ? "deferred (sync active)" : `checked ${autoMerge.checked}, ${autoMerge.ready} ready, ${autoMerge.buildGateBlocked} build-gate-blocked, ${autoMerge.accumulationBlocked} accumulation-blocked, ${autoMerge.goalBoundBlocked} goal-bound-handed-off, ${autoMerge.testsGateBlocked} tests-gate-blocked, merged ${autoMerge.merged}${autoMerge.mergedPr ? ` (PR #${autoMerge.mergedPr})` : ""}`) : "disabled (kill-switch)"}`,
        );
      } catch (err) {
        console.error("[github-webhook] auto-merge gate failed:", err);
      }
    }
    ranGates++;

    // Gate B — spec→goal-branch promotion (spec-goal-branch-pm-flow M4). GitHub /merges API (no local
    // checkout) so it runs here AND in the box worker standing pass. Does NOT push the goal branch to main.
    if (deadlineHit()) {
      console.warn("[github-webhook] after() deadline hit, deferring %d gate(s)", remaining());
      return;
    }
    if (mergeRelevant) {
      try {
        const goalPromote = await promoteEligibleSpecsToGoalBranch();
        if (goalPromote.promoted.length || goalPromote.conflicts.length || goalPromote.goalBranchesCreated.length) {
          console.log(
            `[github-webhook] ${event}: goal-promote merged ${goalPromote.promoted.length} (${goalPromote.promoted.join(", ") || "—"}), seeded ${goalPromote.goalBranchesCreated.length} goal branch(es), ${goalPromote.conflicts.length} conflict(s)${goalPromote.conflicts.length ? ` (${goalPromote.conflicts.join(", ")})` : ""}`,
          );
        }
      } catch (err) {
        console.error("[github-webhook] goal-branch promote failed:", err);
      }
    }
    ranGates++;

    // Gate C — ATOMIC goal→main promotion (spec-goal-branch-pm-flow M5). The only shipped-writer for
    // goal-bound member phases; parent goals skip (their children promote independently); one-off specs
    // ship via Gate A (not here).
    if (deadlineHit()) {
      console.warn("[github-webhook] after() deadline hit, deferring %d gate(s)", remaining());
      return;
    }
    if (mergeRelevant) {
      try {
        const goalToMain = await promoteCompleteGoalsToMain();
        if (goalToMain.promoted.length || goalToMain.conflicts.length) {
          console.log(
            `[github-webhook] ${event}: goal→main promoted ${goalToMain.promoted.length} (${goalToMain.promoted.join(", ") || "—"}), ${goalToMain.conflicts.length} conflict(s)${goalToMain.conflicts.length ? ` (${goalToMain.conflicts.join(", ")})` : ""}, ${goalToMain.parentExempt.length} parent-exempt`,
          );
        }
      } catch (err) {
        console.error("[github-webhook] goal→main atomic promote failed:", err);
      }
    }
    ranGates++;
  });

  return NextResponse.json({ ok: true, deferred: true });
}
