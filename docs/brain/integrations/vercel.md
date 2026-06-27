# integrations/vercel

The hosting + edge platform. This page covers two surfaces:

1. **Project build-gate (Ignored-Build-Step)** — the API the box uses to flip on per-build preview deploys for SPEC-BUILD branches (`claude/build-*`) ([[../libraries/vercel-project]], [[../goals/preview-test-promote-pipeline]] M1, narrowed by `vercel-skip-non-spec-build-refs`).
2. **Edge Config** — the globally-replicated KV the PDP edge middleware reads for the active-experiment manifest ([[../libraries/experiment-manifest]]).

The broader Vercel surface (deploys, ISR, log drain) is covered in [[vercel-log-drain]] and the deploy notes in `CLAUDE.md`.

## Ignored-Build-Step override — preview deploys for SPEC-BUILDS (`claude/build-*`)

**What:** Vercel's per-project `commandForIgnoringBuildStep` is a shell script Vercel runs against every push to decide whether to BUILD (`exit 1`) or SKIP (`exit 0`) that ref. By default the project skips every non-production ref, so a box-pushed branch never produces a preview deployment. M1 of [[../goals/preview-test-promote-pipeline]] PATCHes the command so production AND spec-build refs BUILD, while every incidental branch (a stale `feature/x`, an open-source dep PR, a topic branch) still skips.

**Narrowed (`vercel-skip-non-spec-build-refs`, 2026-06-27):** the original M1 command whitelisted ALL `claude/*` refs — which built every foreman lane, including folds (`claude/fold-*`). A fold's preview build FAILS (the worktree is `main` + brain-only edits, no app change to deploy meaningfully) and the failing Vercel check left fold PRs `UNSTABLE`, blocking the merge (#816/#817). Fix: spec-builds now carry a distinct `claude/build-` prefix (set in `runBuildJob`, `scripts/builder-worker.ts`) and the whitelist matches `^claude/build-` ONLY. Every other `claude/*` lane (fold / goal-fold / plan / spec-chat / dev-ask / director-coach) now SKIPS — none of them need a preview (only spec-builds get pre-merge spec-tested against their preview origin).

### The override command

```sh
if [ "$VERCEL_ENV" = production ] || echo "$VERCEL_GIT_COMMIT_REF" | grep -q '^claude/build-'; then exit 1; else exit 0; fi
```

- `$VERCEL_ENV = production` → BUILD (unchanged — production deploys are never skipped).
- `$VERCEL_GIT_COMMIT_REF` starts with `claude/build-` → BUILD (the spec-build lane — the only one that needs a per-build preview).
- anything else (incl. `claude/fold-*`, `claude/plan-*`, `claude/spec-chat-*`, …) → SKIP (the safety rail — the override does NOT re-enable previews for non-spec-build lanes).

This is the EXACT command [[../libraries/vercel-project]] exports as `CLAUDE_PREVIEW_IGNORE_COMMAND`. The literal string is the contract — its `^claude/build-` + `exit 0` shape is asserted by `scripts/_check-vercel-ignore-step-rails.ts` so a code change can't silently widen the build set back to all `claude/*`.

> **Auto-heal binds the live value to the code.** The box worker re-PATCHes this command to `CLAUDE_PREVIEW_IGNORE_COMMAND` on EVERY tick (~5s). So a bare Vercel-API PATCH does NOT durably change the live value — the box reverts it to whatever the running `builder-worker.ts` exports within one tick. Changing the override for real = change `CLAUDE_PREVIEW_IGNORE_COMMAND` in code AND get the box worker running the new code (merge to `main` → box `git pull` → worker restart).

### Endpoints

- **Read:** `GET https://api.vercel.com/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}` → returns `commandForIgnoringBuildStep`.
- **Write:** `PATCH https://api.vercel.com/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}` with body `{ commandForIgnoringBuildStep: <command> }`.
- **Per-branch deployments (read-only):** `GET https://api.vercel.com/v6/deployments?projectId=…&teamId=…&meta-githubCommitRef=<branch>` — the lookup the preview-URL capture path uses; refuses to run for `main` / `master` so it can NEVER resolve a production URL.

| | |
|---|---|
| Project | `prj_80PnLIjdKT4YAxITnbjkTCgbP0Qv` (`shopcx`) |
| Team | `team_7VetGZ2S7RsYHDoX2bSoB6En` (`dylan-ralstons-projects`) |

### Credentials

- `VERCEL_API_TOKEN` (preferred — already used by [[../libraries/experiment-manifest]]'s Edge Config write path and by the workspace integration routes), with `VERCEL_TOKEN` as a fallback. **Never hardcoded** — both helpers read from `process.env` per call and throw if neither is set.
- The token needs project-read + project-write scope on `dylan-ralstons-projects`. Rotate by replacing the value in the box's systemd `EnvironmentFile`; it takes effect on the next `scripts/apply-vercel-ignore-step-override.ts` invocation.

### Applying / re-applying

The **box worker (`scripts/builder-worker.ts`) is now the primary path**: it calls `patchIgnoredBuildStep()` once at startup AND once at the top of every poll-loop tick, both wrapped in try/catch so a thrown error never crashes the worker. The helper is idempotent (GETs the current command first; no-ops when it already matches `CLAUDE_PREVIEW_IGNORE_COMMAND`; only PATCHes on diff), so steady-state cost is one Vercel GET per tick. A manual revert in the Vercel dashboard is healed by the very next tick (~5s) — visible in worker logs as `vercel-project: commandForIgnoringBuildStep updated. before: … after: …`.

The manual recipe is the **break-glass** path (also idempotent — used when bringing up a fresh project or after a token rotation):

```sh
npx tsx scripts/apply-vercel-ignore-step-override.ts
```

The build console shows the live `commandForIgnoringBuildStep` value (cached ~60s) so the supervisor can see preview builds are enabled without running anything — and the chip + the spec-test agent remain as the secondary signal if the auto-heal itself ever keeps failing (regression-of: per-build-vercel-preview-deploys).

### Safety rails

- **`claude/build-*` only.** The else-branch is `exit 0` (SKIP) — an incidental branch AND every non-spec-build foreman lane (folds/plans/spec-chat/…) is NOT rebuilt. The `scripts/_check-vercel-ignore-step-rails.ts` grep gate fails CI if the constant ever loses the `^claude/build-` discriminator or the `exit 0` else-branch (i.e. if it widens back to all `claude/*`).
- **Read-only deployments lookup.** `listDeploymentsForBranch` refuses `main` / `master` / empty — the capture path cannot accidentally resolve to a production URL.
- **Neither helper promotes or merges.** The only mutation surface is `PATCH …/v9/projects/{id}` (the override write); preview promotion / merge is M4's bounded action, owned elsewhere.



## Edge Config — the active-experiment manifest store

**What:** a globally-replicated, ultra-low-latency read-only KV that the edge middleware can read without a network round-trip to origin. Used to hold the **active-experiment manifest** (`storefront_experiment_manifest` key) so `src/lib/supabase/middleware.ts` can sticky-assign a PDP variant at the edge per request (pdp-edge-served-experiments).

### Status — NOT YET PROVISIONED (owner step)
As of 2026-06-23 no Edge Config store is connected (`EDGE_CONFIG` is unset). The system runs the **cached-JSON-blob fallback**: the middleware fetches `GET /api/storefront/experiment-manifest` (short `s-maxage`, module-cached 15s) instead of Edge Config. This is correct but adds one same-origin fetch per ~15s per edge instance and propagates state changes within ~15s rather than sub-second.

**To provision (optimal):**
1. Vercel dashboard → project `shopcx` → Storage → **Create Edge Config** (e.g. `shopcx-experiments`), connect it to the project. This injects the `EDGE_CONFIG` connection string env automatically.
2. Add two more env vars for the optimizer's write path: `EDGE_CONFIG_ID` (the `ecfg_…` id) and `VERCEL_API_TOKEN` (a token with Edge Config write scope).
3. Redeploy. `isEdgeConfigWriteConfigured()` flips true → `publishExperimentManifest` PATCHes the Edge Config item on every experiment state change (sub-second, no deploy); the middleware reads the item directly via the connection string's HTTP endpoint (no origin fetch).

No code change is needed — both the read path (middleware) and the write path (`publishExperimentManifest`) already branch on the env and activate automatically once the store + tokens are present.

### Endpoints
- **Read (middleware):** `GET ${EDGE_CONFIG}/item/storefront_experiment_manifest` (the connection string carries the read token in its query).
- **Write (optimizer):** `PATCH https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items` with `Authorization: Bearer ${VERCEL_API_TOKEN}`, body `{ items: [{ operation: "upsert", key, value }] }`.

### Credentials
- `EDGE_CONFIG` — connection string (read token embedded). Injected on connect.
- `EDGE_CONFIG_ID` — `ecfg_…` store id (write path).
- `VERCEL_API_TOKEN` — Vercel API token, Edge Config write scope (write path).

### Gotchas
- **Read-only at the edge.** Edge Config is for reads; writes go through the Vercel REST API from the server (the optimizer), never the middleware.
- **Fallback is always safe.** If the manifest read fails (missing key, fetch error) the middleware degrades to "no experiment → the real cached PDP" — never an error to the shopper.
- **Propagation, not transactions.** Edge Config upserts replicate within ~seconds; the manifest is advisory (the page re-guards `_sxv` against the DB), so a brief staleness only means a visitor lands on control until replication completes.
