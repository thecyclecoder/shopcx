# integrations/github-webhook

The **inbound GitHub webhook** that fires the **Dirty-PR Resolver Agent** ([[../specs/dirty-pr-resolver-agent]]). GitHub POSTs to `POST /api/webhooks/github` on the events that can dirty an open build PR; the handler detects the newly-`CONFLICTING` `claude/*` PRs and enqueues a [[../tables/agent_jobs]] `kind='pr-resolve'` job for each. **Event-driven, not a cron** — it fires the moment a merge to `main` dirties something.

## Endpoint (HMAC-verified)

| Route | Handles |
|---|---|
| `POST /api/webhooks/github` | `push` (to `main`), `pull_request` (opened·synchronize·reopened·ready_for_review), `ping` |

Verification runs **first** on the raw body: `verifyGithubWebhook(rawBody, X-Hub-Signature-256, GITHUB_WEBHOOK_SECRET)` ([[../libraries/github-pr-resolve]]) — HMAC-SHA256(`GITHUB_WEBHOOK_SECRET`, raw bytes), constant-time compared against the `sha256=<hex>` header. A missing/invalid signature → `401`. Without it anyone who learns the URL could spoof a build-queue enqueue. A `ping` (sent when the hook is first configured) is acked `{ok,pong}`.

## Flow

1. Verify signature → parse → read `X-GitHub-Event`.
2. **Relevance filter** — only a `push` to `refs/heads/main` (the event that moves the base every other PR merges against) or a `pull_request` open/synchronize/reopen/ready event proceeds; everything else is acked `{ok, skipped}` with no work.
3. `detectAndEnqueueDirtyPrs()` ([[../libraries/github-pr-resolve]]) — list open `claude/*` PRs → check each `mergeable` (polled, since GitHub recomputes it async after a push) → enqueue ONE deduped `pr-resolve` job per newly-`CONFLICTING` PR.
4. Respond `{ok, checked, conflicting, enqueued, prs[]}`.

The box worker's `pr-resolve` lane (`runPrResolveJob`, [[../recipes/build-box-setup]]) then claims each job and does the merge + resolve + tsc-gate + push (or rebuild-on-main / surface-to-owner).

## Setup

Configure a repository webhook on `thecyclecoder/shopcx` → payload URL `https://shopcx.ai/api/webhooks/github`, content type `application/json`, secret = the `GITHUB_WEBHOOK_SECRET` env value, events: **Pushes** + **Pull requests**. The detection calls back into the GitHub REST API with `GITHUB_TOKEN` / `AGENT_TODO_GITHUB_TOKEN` (the same token the build console uses to list/close PRs).

## Gotchas

- **`mergeable` is lazy.** Right after a push it's `null` (still computing); the detector polls the single-PR GET a few times before deciding. A still-`null` result is skipped — a later event re-checks it. See [[../libraries/github-pr-resolve]].
- **`claude/*` only.** A non-`claude/*` PR (a human PR) or a clean PR triggers nothing — the relevance filter + the `claude/*` head-ref filter + the `mergeable === false` gate all have to pass.
- **Repo-level, one workspace.** No per-workspace secret/lookup (unlike the [[shopify|Shopify]] / Appstle webhooks) — one repo serves one build console, so the job attaches to the build-console workspace.
- **Idempotent.** `push` + `synchronize` can both fire for the same change; `enqueuePrResolveJob` dedupes one active job per PR.
