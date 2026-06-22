# github-pr-resolve.ts

`src/lib/github-pr-resolve.ts` — the **detection + enqueue half** of the **Dirty-PR Resolver Agent** ([[../specs/dirty-pr-resolver-agent]]). North star (supervisable autonomy): parallel + rebuilt builds keep producing dirty (`CONFLICTING`) `claude/*` PRs; this library is the bounded *proxy* the [[../integrations/github-webhook|GitHub webhook]] calls to **detect** them and enqueue ONE resolver job each — the box agent (`runPrResolveJob`) owns the actual merge + the resolve-vs-rebuild-vs-human decision. Touches **`claude/*` build branches only**.

## Exports

- **`verifyGithubWebhook(rawBody, signatureHeader, secret) → boolean`** — verify the `X-Hub-Signature-256` header GitHub sends (`sha256=<hex>` = HMAC-SHA256(secret, raw body)). Constant-time (`timingSafeEqual`); rejects a missing/malformed header, an unconfigured secret, or a length/digest mismatch. Mirrors [[meta]] `verifyMetaWebhookSignature` — the **raw bytes as received** MUST be used (JSON re-encoding breaks the digest). Secret = `GITHUB_WEBHOOK_SECRET`.
- **`detectAndEnqueueDirtyPrs(admin?) → DirtyPrResult`** — the webhook's whole job: list open PRs, keep `claude/*` ones, check each `mergeable`, enqueue a deduped `pr-resolve` job for the newly-`CONFLICTING` ones. Best-effort + bounded — a transient GitHub error on one PR doesn't block the rest. Returns `{ checked, conflicting, enqueued, prs[] }`.
- **`enqueuePrResolveJob(admin, { workspaceId, prNumber, branch, reason? }) → { enqueued, reason? }`** — insert a `kind='pr-resolve'` [[../tables/agent_jobs]] row (`spec_slug = pr-{number}`, `spec_branch = branch`, `pr_number`, `instructions = {pr_number, branch, reason}`). **Idempotent:** no-op if an active pr-resolve job already exists for this PR (dedupe key = `pr-{number}`), so a burst of `push` + `synchronize` events for the same PR enqueues once.
- Type `DirtyPrResult`.

## Mergeable is lazy

GitHub computes `mergeable` **asynchronously** — it's `null` on the `GET /pulls` list endpoint and right after a push to `main`, then settles to `true|false` a moment later. `fetchMergeable(prNumber)` GETs the single PR up to 4× (~1.2s apart) until it settles; `null` after the budget = "unknown" → **skip** (a later event re-checks). Only `mergeable === false` (CONFLICTING) enqueues; `true` (clean) and `null` (unknown/merged/closed) are no-ops.

## Workspace

A repo-level webhook isn't workspace-scoped, so `resolveBuildWorkspaceId(admin)` attaches the job to the **build-console workspace** — the most-recent `agent_jobs.workspace_id` (i.e. the workspace that actually runs builds), falling back to the first `workspaces` row. Mirrors the system-level enqueue pattern in [[../inngest/spec-test-cron]].

## Callers

- [[../integrations/github-webhook]] (`POST /api/webhooks/github`) — calls `verifyGithubWebhook` then `detectAndEnqueueDirtyPrs` on `push` to `main` / `pull_request` opened·synchronize·reopened·ready_for_review.

## Gotchas

- **`claude/*` only.** `detectAndEnqueueDirtyPrs` filters `head.ref` to `claude/*` before doing anything — a human PR or `main` is never touched (guardrail).
- **Detection ≠ resolution.** This library only *enqueues*. The merge, the additive conflict resolution, the **tsc gate**, the push, and the rebuild-on-main / surface-to-owner decision all live in `scripts/builder-worker.ts` `runPrResolveJob` (the `pr-resolve` lane). See [[../recipes/build-box-setup]] + [[../tables/agent_jobs]].
- **Idempotent + deduped.** One active pr-resolve job per PR; a PR it can't fix lands `needs_attention` (surfaced) or is rebuilt, never retried in a loop.
