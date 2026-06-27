# libraries/preview-capture

The per-build Vercel preview-URL capture path for [[../specs/per-build-vercel-preview-deploys]] Phase 2.

One `claude/*` build branch = one Vercel preview deployment (Phase 1 flipped the project's Ignored-Build-Step so `claude/*` builds). This module resolves that deployment via [[vercel-project]] `getLatestReadyDeploymentForBranch` and persists it on the owning [[../tables/agent_jobs]] row — `preview_url` (the `https://…vercel.app` URL once READY) and `preview_state` (the latest known Vercel state). [[../specs/spec-test-on-preview-pre-merge]] reads both to decide "preview exists / preview ready" before enqueuing its pre-merge spec-test.

**File:** `src/lib/preview-capture.ts`

## Exports

### `capturePreviewUrlForJob({ jobId, branch, commitSha? })` → `PreviewCaptureResult`

The single-shot capture.

1. Refuses a non-`claude/*` branch (returns `{ updated: false, reason: "not a claude/* branch" }`).
2. Calls [[vercel-project]] `getLatestReadyDeploymentForBranch(branch, commitSha)` to find the latest deployment for the branch. Preferring a READY deployment whose `meta.githubCommitSha` matches keeps a stale earlier preview from being mis-attributed to a later commit on the same branch.
3. Reads the current `agent_jobs.preview_url` + `preview_state`; updates only when the values differ — idempotent.
4. **Never NULLs an already-persisted URL** on a re-poll that briefly fails to surface READY (Vercel's listing is eventually-consistent). The URL only advances forward; the state column always reflects the latest known state.

Returns `{ updated, previewUrl, previewState, reason? }`. Never throws — every error path collapses to a `reason` string.

### `pollCapturePreviewUrl(opts, poll?)` → `PreviewCaptureResult`

Polling wrapper. Re-calls `capturePreviewUrlForJob` every `intervalMs` (default 15s) until either:

- the deployment reaches `READY` (with a URL) → returns immediately,
- the deployment hits a terminal `ERROR` / `CANCELED` → returns immediately,
- the wall-clock `timeoutMs` (default 6 min) elapses → returns the last result.

Every iteration writes the latest known state to the job row (idempotent), so even an interrupted poll leaves M3-actionable signal on the row.

The box worker (`scripts/builder-worker.ts`) calls this **fire-and-forget** (`void pollCapturePreviewUrl(...)`) right after `git push` succeeds — Vercel hasn't picked the branch up yet at push time, but by the time the first 15s tick fires the deployment is usually `QUEUED → BUILDING → READY` within ~5 min.

## Idempotency + re-polling

The helper is designed to be called repeatedly:

- the worker calls it once per build (the post-push poll above),
- a future cron / [[../specs/spec-test-on-preview-pre-merge]] enqueue / a board refresh can re-call it — the read-modify-write skips when nothing changed.

A worker restart drops in-flight polls. That's acceptable for Phase 2: the column on the row is the durable state; a re-call from any of the above paths re-stamps it.

## Safety rails

- **Read-only against Vercel** — this module CANNOT promote or merge anything (that is M4's bounded action).
- **Best-effort + non-fatal.** Every error (Vercel 5xx, network blip, missing row) collapses to a `reason` string; the build itself never fails on a preview-lookup hiccup.
- **`claude/*` branches only.** The hard rail in `vercel-project.listDeploymentsForBranch` rejects `main` / `master`; this module belt-and-suspenders rejects any branch without the `claude/` prefix.
- **URL only advances forward.** A flapping Vercel listing can't unset an already-captured `preview_url`.

## Callers

- **[[../recipes/build-box-setup|box worker]]** — `scripts/builder-worker.ts` `runJob` calls `pollCapturePreviewUrl` after the build's `git push` succeeds (fire-and-forget; the worker's job-loop process outlives the per-job invocation).

## Related

[[vercel-project]] · [[agent-jobs]] · [[../tables/agent_jobs]] · [[../specs/per-build-vercel-preview-deploys]] · [[../specs/spec-test-on-preview-pre-merge]] · [[../goals/preview-test-promote-pipeline]]
