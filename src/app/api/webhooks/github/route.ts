import { NextResponse } from "next/server";
import { verifyGithubWebhook, detectAndEnqueueDirtyPrs, autoMergeReadyPrs } from "@/lib/github-pr-resolve";

/**
 * GitHub webhook → Dirty-PR Resolver Agent trigger (docs/brain/specs/dirty-pr-resolver-agent.md).
 *
 * GitHub POSTs here on:
 *   - `push` to `main` — the event that *makes* other open PRs conflict.
 *   - `pull_request` opened/synchronize/reopened/ready_for_review.
 *   - `check_suite` / `check_run` completed + `status` — a build PR's checks just went green (the event
 *      that makes a PR READY to auto-merge). Needed only by Gate A below.
 * On either, we run TWO mirror gates over the open `claude/*` PRs:
 *   1. Dirty-PR resolver (CONFLICTING half): list, check each `mergeable` (GitHub recomputes it async
 *      after a push, so a null is polled briefly), and enqueue ONE deduped `pr-resolve` agent_jobs row for
 *      any that just became CONFLICTING. The box worker (`runPrResolveJob`) then merges origin/main,
 *      resolves the (usually additive) conflicts, tsc-gates, and pushes — or rebuilds-on-main / surfaces.
 *   2. Auto-merge gate (READY half — auto-ship-pipeline Phase 1 / Gate A): squash-merge + delete branch
 *      ONE ready (mergeable + all-checks-green) claude/* PR — serialized, sync-aware, owner kill-switch.
 *
 * HMAC verification (X-Hub-Signature-256, secret = GITHUB_WEBHOOK_SECRET) runs first on the raw body —
 * without it anyone who learns the URL could spoof a build-queue enqueue or an auto-merge. A `ping` is
 * acked. No workspace lookup: the repo serves one build console (the job attaches to the build-console
 * workspace, whose `auto_merge_enabled` flag is the Gate A kill-switch).
 *
 * Webhook events to subscribe in GitHub: Pushes, Pull requests (the dirty-PR resolver) PLUS Check suites,
 * Check runs, Statuses (so Gate A fires the moment a PR's checks go green).
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

  if (!dirtyRelevant && !mergeRelevant) return NextResponse.json({ ok: true, skipped: event });

  try {
    const dirty = dirtyRelevant
      ? await detectAndEnqueueDirtyPrs()
      : { checked: 0, conflicting: 0, enqueued: 0, closedDuplicate: 0, prs: [] };
    if (dirtyRelevant) {
      console.log(
        `[github-webhook] ${event}: checked ${dirty.checked} claude/* PR(s), ${dirty.conflicting} conflicting, ${dirty.enqueued} pr-resolve job(s) enqueued, ${dirty.closedDuplicate} closed as already-merged duplicate(s)`,
      );
    }

    // Gate A — auto-merge ready PRs (serialized, sync-aware, kill-switched). Independent of the dirty gate;
    // a failure in one must not block the other.
    let autoMerge: Awaited<ReturnType<typeof autoMergeReadyPrs>> | undefined;
    if (mergeRelevant) {
      try {
        autoMerge = await autoMergeReadyPrs();
        console.log(
          `[github-webhook] ${event}: auto-merge ${autoMerge.enabled ? (autoMerge.syncActive ? "deferred (sync active)" : `checked ${autoMerge.checked}, ${autoMerge.ready} ready, ${autoMerge.buildGateBlocked} build-gate-blocked, ${autoMerge.accumulationBlocked} accumulation-blocked, ${autoMerge.testsGateBlocked} tests-gate-blocked, merged ${autoMerge.merged}${autoMerge.mergedPr ? ` (PR #${autoMerge.mergedPr})` : ""}`) : "disabled (kill-switch)"}`,
        );
      } catch (err) {
        console.error("[github-webhook] auto-merge gate failed:", err);
      }
    }

    return NextResponse.json({ ok: true, ...dirty, autoMerge });
  } catch (err) {
    console.error("[github-webhook] dirty-PR detection failed:", err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
