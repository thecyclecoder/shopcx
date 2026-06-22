import { NextResponse } from "next/server";
import { verifyGithubWebhook, detectAndEnqueueDirtyPrs } from "@/lib/github-pr-resolve";

/**
 * GitHub webhook → Dirty-PR Resolver Agent trigger (docs/brain/specs/dirty-pr-resolver-agent.md).
 *
 * GitHub POSTs here on:
 *   - `push` to `main` — the event that *makes* other open PRs conflict.
 *   - `pull_request` opened/synchronize/reopened/ready_for_review.
 * On either, we list open `claude/*` PRs, check each `mergeable` (GitHub recomputes it async after a
 * push, so a null is polled briefly), and enqueue ONE deduped `pr-resolve` agent_jobs row for any that
 * just became CONFLICTING. The box worker (`runPrResolveJob`) then merges origin/main, resolves the
 * (usually additive) conflicts, tsc-gates, and pushes — or rebuilds-on-main / surfaces to the owner.
 *
 * HMAC verification (X-Hub-Signature-256, secret = GITHUB_WEBHOOK_SECRET) runs first on the raw body —
 * without it anyone who learns the URL could spoof a build-queue enqueue. A `ping` is acked. No
 * workspace lookup: the repo serves one build console (the job attaches to the build-console workspace).
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

  // Decide whether this delivery can have dirtied an open claude/* PR.
  let relevant = false;
  if (event === "push") {
    // Only a push to main moves the base every other PR merges against.
    relevant = payload.ref === "refs/heads/main";
  } else if (event === "pull_request") {
    const action = String(payload.action || "");
    relevant = ["opened", "synchronize", "reopened", "ready_for_review"].includes(action);
  }

  if (!relevant) return NextResponse.json({ ok: true, skipped: event });

  try {
    const result = await detectAndEnqueueDirtyPrs();
    console.log(
      `[github-webhook] ${event}: checked ${result.checked} claude/* PR(s), ${result.conflicting} conflicting, ${result.enqueued} pr-resolve job(s) enqueued`,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[github-webhook] dirty-PR detection failed:", err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
