# libraries/vercel-project

The narrow Vercel REST API surface the per-build preview-deploy pipeline needs ([[../goals/preview-test-promote-pipeline]] M1). Two responsibilities — and no more:

1. **Idempotently override the project's Ignored-Build-Step** so SPEC-BUILD branches (`claude/build-*`) produce a preview deployment — and ONLY those (`vercel-skip-non-spec-build-refs`).
2. **Read-only look up of a branch's latest preview deployment** so the worker can persist its URL on the owning `agent_jobs` row.

Anything mutating outside #1 (canceling a deploy, promoting a preview, redeploying) lives elsewhere — neither helper here can promote or merge.

**File:** `src/lib/vercel-project.ts`

## Project + team identity

| | |
|---|---|
| Project | `prj_80PnLIjdKT4YAxITnbjkTCgbP0Qv` (Vercel project for `shopcx`) |
| Team | `team_7VetGZ2S7RsYHDoX2bSoB6En` (`dylan-ralstons-projects`) |

Both ids are constants in the module — re-exported as `VERCEL_PROJECT_IDS` for tests / scripts that need to log them, never used to bypass an env read.

## Auth — the token

Reads `process.env.VERCEL_API_TOKEN` (preferred — already used by [[experiment-manifest]] for the Edge Config write path and by the workspace integration routes), with `VERCEL_TOKEN` as a fallback. **NEVER hardcoded.** Both helpers throw if neither is set.

## Exports

### `patchIgnoredBuildStep(desired?)` → `{ before, after, changed }`

The supervisable-autonomy override write.

1. `GET /v9/projects/{PROJECT_ID}?teamId={TEAM_ID}` → reads the current `commandForIgnoringBuildStep`.
2. If `before === desired` → no-op + `changed: false` (idempotent).
3. Otherwise `PATCH /v9/projects/{PROJECT_ID}?teamId={TEAM_ID}` with `{ commandForIgnoringBuildStep: desired }`.
4. Console-logs the before/after so the override is auditable from the build console (supervisable autonomy: the tool surfaces its reasoning).

`desired` defaults to **`CLAUDE_PREVIEW_IGNORE_COMMAND`** — the exact override (narrowed to spec-builds by `vercel-skip-non-spec-build-refs`, 2026-06-27):

```sh
if [ "$VERCEL_ENV" = production ] || echo "$VERCEL_GIT_COMMIT_REF" | grep -q '^claude/build-'; then exit 1; else exit 0; fi
```

Vercel runs this in `/bin/sh`: `exit 1` means BUILD, `exit 0` means SKIP. So:

- production deploys (`$VERCEL_ENV = production`) → BUILD (unchanged)
- spec-build branches (`claude/build-*` — `runBuildJob`'s lane) → BUILD (the only lane that needs a per-build preview, for pre-merge spec-testing)
- any other branch — incl. EVERY other foreman lane (`claude/fold-*`, `claude/goal-fold-*`, `claude/plan-*`, `claude/spec-chat-*`, `claude/dev-ask-*`, `claude/director-coach-*`) and any incidental topic / dependabot push → SKIP

That last property is the safety rail: the override builds `claude/build-*` ONLY — it does NOT build folds or any other `claude/*` lane. (Pre-2026-06-27 it whitelisted all `claude/*`, which built folds too — a fold's preview FAILS and blocked the fold PR merge; `vercel-skip-non-spec-build-refs` fixed it by giving spec-builds a distinct prefix.)

> **The live value is bound to this constant by the auto-heal.** The box worker re-PATCHes the override to `CLAUDE_PREVIEW_IGNORE_COMMAND` on every tick, so a bare Vercel-dashboard/API change is reverted within ~5s to whatever the RUNNING `builder-worker.ts` exports. Changing the override durably = change this constant in code AND get the box running the new code (merge to `main` → box `git pull` → worker restart).

### `getProjectIgnoreState()` → `{ commandForIgnoringBuildStep }`

The plain GET if a caller wants to inspect the current command without mutating. Used by `patchIgnoredBuildStep` internally and exported for diagnostics.

### `listDeploymentsForBranch(branch, limit?)` → `Deployment[]`

`GET /v6/deployments?projectId=…&teamId=…&meta-githubCommitRef={branch}&limit={limit}` — the newest deployments for a single branch, newest first. Read-only.

Hard rail: refuses to run for `main` / `master` / empty `branch` — this helper exists to find a `claude/*` preview, never to resolve a production URL.

Each row is normalized to `{ uid, url, state, target, meta, createdAt }` so the caller doesn't have to handle Vercel's `state` vs `readyState` schema drift.

### `getLatestReadyDeploymentForBranch(branch, commitSha?)` → `{ latest, ready }`

The capture-path lookup used by M1 Phase 2.

- Lists the branch's recent deployments (above), drops any `target: "production"` row.
- `latest`: newest of any state — lets the caller surface "still BUILDING" without re-querying.
- `ready`: newest `state === "READY"`. When `commitSha` is supplied, prefer a READY whose `meta.githubCommitSha` matches — keeps an earlier preview from being mis-attributed to a later commit on the same branch. Falls back to the newest READY on the branch when no exact-SHA match is present.

### `previewHttpsUrl(deployment)` → `string | null`

Convenience: prepend `https://` to a `Deployment.url` (Vercel returns the bare host).

## Endpoints

| Method | URL | Purpose |
|---|---|---|
| `GET` | `/v9/projects/{PROJECT_ID}?teamId={TEAM_ID}` | Read the project's `commandForIgnoringBuildStep`. |
| `PATCH` | `/v9/projects/{PROJECT_ID}?teamId={TEAM_ID}` | Write `commandForIgnoringBuildStep`. The single mutation surface this module exposes. |
| `GET` | `/v6/deployments?projectId=…&teamId=…&meta-githubCommitRef={branch}` | List deployments for one branch — read-only, never a prod URL. |

## Callers

- **[[../recipes/apply-vercel-ignore-step-override]]** — `scripts/apply-vercel-ignore-step-override.ts` re-applies the override deterministically (a second run is a no-op). The break-glass / manual path; the primary path is the box-worker auto-heal below.
- **`scripts/builder-worker.ts`** (regression-of: per-build-vercel-preview-deploys) — calls `patchIgnoredBuildStep()` once at worker startup AND once at the top of every poll-loop tick, wrapped in try/catch. Idempotent (GET → no-op on match → PATCH on diff), so steady-state cost is one GET/tick. This is now the PRIMARY way the override is re-asserted: a manual dashboard revert is healed by the next tick (~5s). The chip + spec-test agent remain as the secondary signal if the auto-heal itself keeps failing.
- **[[preview-capture]]** (M1 Phase 2) — `src/lib/preview-capture.ts` `capturePreviewUrlForJob` / `pollCapturePreviewUrl` calls `getLatestReadyDeploymentForBranch(job.spec_branch, sha)` and persists the URL + state on the owning `agent_jobs` row (`preview_url` / `preview_state`). The box worker (`scripts/builder-worker.ts`) fires the poll right after `git push` succeeds — fire-and-forget, idempotent, best-effort.
- **`/api/roadmap/box`** (M1 Phase 3) — server-side calls `getProjectIgnoreState()` with a 60s module cache and exposes the result as `preview_build_override` on the box-page payload. The `/dashboard/roadmap/box` page renders a chip (`enabled` · `drifted` · `unknown`) so the supervisor can SEE preview builds are on without running the apply script (supervisable autonomy: see + pause).

## Safety rails

- The override builds `claude/*` ONLY. Incidental branches (no `claude/` prefix, not production) still skip — this is preserved by the literal command string + the Phase 3 grep gate at `scripts/_check-vercel-ignore-step-rails.ts` (wired into `npm run predeploy`). The gate asserts the constant still carries the `^claude/` anchor, the `production` env check, the `exit 1` build branch, and the `exit 0` skip branch; CI fails red if a code change ever weakens any of them.
- The deployments lookup is **read-only** against Vercel and refuses to run for `main` / `master` — neither helper can promote or merge.
- Token is read from `process.env` per call. No module-level capture, no hardcoded fallback — rotating the token in the systemd `EnvironmentFile` takes effect on the next invocation.
- The build-console chip surfaces the live override state from a 60s server-side cache — the supervisor can see the override is in place + pause the tool without SSH (supervisable autonomy).

## Related

[[experiment-manifest]] · [[../integrations/vercel]] · [[../tables/agent_jobs]] · [[../goals/preview-test-promote-pipeline]]
