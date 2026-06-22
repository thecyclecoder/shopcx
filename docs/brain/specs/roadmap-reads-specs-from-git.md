# Roadmap Reads Spec Phases from Git/Main at Request Time ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[roadmap-build-console]] + [[roadmap-status-accuracy]]. Kills the deploy-lag on phase status.

`getRoadmap()` ([[../libraries/brain-roadmap]]) reads `docs/brain/specs/*.md` from the **filesystem baked into the deployed build** (`process.cwd()/docs/brain/specs`). So when a spec's phase emoji flips on `main` (a build merges, the spec-drift agent stamps ✅, a fold lands) the board keeps showing the **old** status until the app redeploys — minutes-to-hours of lag. Observed live: `error-feed-monitoring` showed "P2 planned" on the board while `main` had P2 ✅. Read the spec content from **main at request time** instead, so phase status is always current.

## Design
- **Read specs from `main`, not the bundled copy.** A new resolver fetches `docs/brain/specs/` content from `main` via the GitHub API (reuse the `gh("GET", …)` Contents-API helper pattern in [[../inngest/brain-index-refresh]], auth `GITHUB_TOKEN`). `getRoadmap` / `getArchive` / the spec-detail loader parse that instead of `fs.readFile`.
- **SHA-keyed cache (the efficiency key).** Per request: fetch `main`'s latest commit SHA (1 cheap call: `GET /repos/{repo}/commits/main` or the ref). If the SHA matches the in-memory cache → return the cached parse instantly (the board polls, so most hits are cache hits). If `main` moved → re-fetch the specs tree (Git Trees API `recursive=1` for the `docs/brain/specs` subtree → blob contents, **one batched pass**, not N naive Contents calls) + re-parse + cache under the new SHA. Net: 1 SHA call/request, a full re-fetch only when `main` actually advances → lag drops from "next deploy" to "next request after the commit."
- **Fallback — never break the board.** If GitHub is unreachable / `GITHUB_TOKEN` missing / rate-limited / a fetch errors → **fall back to the baked-in `fs` copy** (today's behavior). The board must always render; freshness is best-effort, correctness/availability is not.
- **Scope:** the board (`getRoadmap`), the archive, and the spec-detail page read from git; the goals/functions loaders can follow the same pattern (lower-priority — they lag less). Keep the parse (`parseSpec`) unchanged — only the *source* of the markdown changes.

## Guardrails
- **Read-only** — this only changes where spec markdown is *read* from; never writes. No new write path.
- **Bounded cost** — the SHA-check is one call; the full re-fetch is gated behind a SHA change + an in-memory TTL floor (e.g. ≥ a few seconds) so a burst of requests during a deploy can't fan out into a fetch storm.
- **Graceful degradation** — any GitHub failure silently falls back to the bundled copy + logs once; a stale-but-rendered board beats a broken one.

## Verification
- Flip a spec's phase emoji on `main` (commit directly, no app redeploy) → within one request the board reflects the new status (no deploy needed). Confirm the bundled copy is still the *old* status (proving it read from git, not fs).
- Hammer the board (poll) → only ~1 `GET commits/main` per request in the logs; a full specs re-fetch only after `main` advances (cache hit otherwise).
- Simulate GitHub down (bad token / network error) → the board still renders from the bundled `fs` copy; one log line notes the fallback; no 500.
- A spec added/removed on `main` appears/disappears on the board at request time (not next deploy).

## Phase 1 — git-backed spec source + SHA cache + fs fallback ✅
The git resolver (Trees + blobs, batched) + SHA-keyed in-memory cache + fs fallback, wired into `getRoadmap`/`getArchive`/spec-detail in [[../libraries/brain-roadmap]]. Brain: [[../libraries/brain-roadmap]] · [[../dashboard/roadmap]] · [[../integrations/github-webhook]] (shares the GitHub-read auth).
