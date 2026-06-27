# libraries/vercel-project

The narrow Vercel REST API surface the per-build preview-deploy pipeline needs ([[../goals/preview-test-promote-pipeline]] M1). Two responsibilities — and no more:

1. **Idempotently override the project's Ignored-Build-Step** so `claude/*` build branches produce a preview deployment.
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

`desired` defaults to **`CLAUDE_PREVIEW_IGNORE_COMMAND`** — the exact override the goal records:

```sh
if [ "$VERCEL_ENV" = production ] || echo "$VERCEL_GIT_COMMIT_REF" | grep -q '^claude/'; then exit 1; else exit 0; fi
```

Vercel runs this in `/bin/sh`: `exit 1` means BUILD, `exit 0` means SKIP. So:

- production deploys (`$VERCEL_ENV = production`) → BUILD (unchanged)
- `claude/anything` build branches → BUILD (the new behavior — the M1 unlock)
- any other branch (an incidental open-source dependabot push, a topic branch, a stale `feature/x`) → SKIP

That last property is the safety rail: the override builds `claude/*` ONLY — it does NOT re-enable every preview.

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

- **[[../recipes/apply-vercel-ignore-step-override]]** — `scripts/apply-vercel-ignore-step-override.ts` re-applies the override deterministically (a second run is a no-op). The PATCH the goal records lives here, not in a hand-flipped dashboard setting.
- M1 Phase 2 will add the preview-URL capture path on the box worker that calls `getLatestReadyDeploymentForBranch(job.spec_branch, sha)` and persists the URL on the owning `agent_jobs` row.

## Safety rails

- The override builds `claude/*` ONLY. Incidental branches (no `claude/` prefix, not production) still skip — this is preserved by the literal command string + a Phase 3 grep gate.
- The deployments lookup is **read-only** against Vercel and refuses to run for `main` / `master` — neither helper can promote or merge.
- Token is read from `process.env` per call. No module-level capture, no hardcoded fallback — rotating the token in the systemd `EnvironmentFile` takes effect on the next invocation.

## Related

[[experiment-manifest]] · [[../integrations/vercel]] · [[../tables/agent_jobs]] · [[../goals/preview-test-promote-pipeline]]
