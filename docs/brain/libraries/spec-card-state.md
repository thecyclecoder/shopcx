# libraries/spec-card-state

The read/write layer over the [[../tables/spec_card_state]] table — the live, instant project-management mirror behind the [[../dashboard/roadmap|Roadmap board]] ([[../specs/spec-card-db-companion]]). Supersedes the disabled `roadmap-reads-specs-from-git`.

**File:** `src/lib/spec-card-state.ts`

## Why this exists

The board parses a card's status from the spec markdown's `⏳/🚧/✅` phase emojis **as bundled in the deployed build** ([[brain-roadmap]]). So a status change — a build merging, a [[spec-drift]] flip, an owner mark — didn't show until a markdown edit + commit + Vercel **deploy** (the deploy-lag that made the board feel stale). This module is the DB companion: the merge / drift / owner / build paths write it the moment the event happens, and the board reads it **DB-first** (markdown fallback when no row exists). **No GitHub API calls for status** — the retired git-read approach burned the quota.

**Canonical-source rule:** markdown stays canonical for content + the durable phase record; this is only the board mirror + transient flags. `resolveBoardStatus` takes whichever of (markdown, mirror) is **further along**, so the mirror only ever moves a card forward and a markdown that's ahead wins.

## Types

- **`SpecCardState`** — `{ workspace_id, spec_slug, status: Phase, phase_states: SpecCardPhaseState[], flags: SpecCardFlags, last_merge_sha, updated_at }`.
- **`SpecCardPhaseState`** — `{ index, title, status: Phase }` (per-phase snapshot; board future-use).
- **`SpecCardFlags`** — `{ deploy_pending?, blocked?, [k]: boolean }` (transient).
- **`DeployState`** — `"deploying" ｜ "live"`.

## Exports

- **`getSpecCardStates(workspaceId)`** → `Record<slug, SpecCardState>` — the board's one DB read.
- **`resolveBoardStatus(markdownStatus, state?)`** → `Phase` — forward-merge of the markdown parse and the mirror (DB-first for the deploy-lag; markdown wins when it's already ahead). `rejected` (phase-level) passes through as the markdown value.
- **`deploymentState(state?, markdownStatus, deployedSha)`** → `DeployState | null` — the `shipped · deploying` → `shipped · live` signal. `live` when the deployed `VERCEL_GIT_COMMIT_SHA` **is** the card's `last_merge_sha`, or a later deploy already carries the flipped emoji (`markdownStatus === "shipped"`); else `deploying`. `null` for a card that isn't shipped / has no row / no merge SHA.
- **`markSpecCardStatus(workspaceId, slug, status, phaseStates?)`** — mirror a derived status + per-phase snapshot (drift reconciler, owner flips). No deploy flag.
- **`markSpecCardMergeShipped(workspaceId, slug, { status, mergeSha, phaseStates? })`** — mirror a just-merged build: `status` + `flags.deploy_pending = true` + `last_merge_sha`.
- **`markSpecCardBlocked(workspaceId, slug, blocked)`** — set/clear the `blocked` transient flag (spec-blockers).

All writers are **best-effort** — `upsertCardState` swallows its own error so a mirror-write failure never breaks the underlying merge / flip / build path. `flags` is read-modify-write **merged** (a merge's `deploy_pending` doesn't clobber a `blocked`).

## Callers

- **Writers:** [[agent-jobs]] `reconcileMergedJobs` (merge) · [[spec-drift]] `reconcileSpecDrift` (drift flip) · `src/app/api/roadmap/status/route.ts` + `src/app/api/roadmap/spec-drift/route.ts` (owner flips).
- **Reader:** `src/app/dashboard/roadmap/page.tsx` (the board — `getSpecCardStates` + `resolveBoardStatus` + `deploymentState`).
- `phaseStatesFromRaw(raw)` lives in [[spec-drift]] (it already parses phases with line numbers) and feeds the per-phase snapshot to the writers.

## Gotchas

- **`deploy_pending` is cleared at READ time, not by a webhook** — `deploymentState` derives `live` from the SHA compare. The stored flag staying `true` is harmless; a merge whose SHA is already live still shows `shipped · live`.
- **No circular import** — this module imports only `supabase/admin` + the `Phase` *type* from [[brain-roadmap]]; [[spec-drift]] / [[agent-jobs]] / the routes import *it* (one direction).
- **`building` stays on the live-job overlay.** A mid-build card shows In progress via the board's existing active-`agent_jobs` overlay (instant + self-clearing on terminal status), which [[../specs/spec-card-db-companion]] generalizes — this mirror persists the *shipped* progression + deploy flag, the parts that actually had deploy-lag.

## Related

[[../tables/spec_card_state]] · [[../specs/spec-card-db-companion]] · [[brain-roadmap]] · [[spec-drift]] · [[agent-jobs]] · [[../dashboard/roadmap]]

---

[[../README]] · [[../../CLAUDE]]
