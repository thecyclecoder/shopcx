# Roadmap status accuracy — phase-consensus + live-job board status ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

The board's column for a spec is derived purely from its markdown emojis, and two gaps make it lie:
1. **Stale title wins over done phases.** `deriveStatus` lets the H1 title emoji override the phases — so a spec with **all phases ✅** but a forgotten **🚧 title** shows as "Doing" even though it shipped + merged (observed: `worker-self-update`).
2. **No optimistic / live status.** Hitting **Build** on a Planned spec doesn't move it — the card sits in Planned until the build flips the emoji and the next deploy re-reads it. It should jump to **In progress** immediately.

Make the board reflect reality: phase consensus + the live `agent_jobs` state.

## Phase 1 — Phase consensus beats a stale title ✅
- ✅ `src/lib/brain-roadmap.ts` `deriveStatus`: when **all phases are ✅** (none `⏳`/`🚧`, not title-`❌`), the spec is **shipped** regardless of the H1 title emoji — a forgotten title no longer overrides a done phase set. (Title still wins for explicit `❌` cut / when there are no phases.)
- ✅ `build-spec` skill: on completion, **flip the H1 title emoji to match** the phase consensus (`✅` when all phases ship), so the markdown is self-consistent too — belt-and-suspenders with the parser fix. (SKILL.md procedure step 4.)

## Phase 2 — Optimistic + live-job status ✅
- ✅ **Live overlay:** the board renders a spec as **In progress** when it has an **active `agent_jobs`** row (`queued`/`claimed`/`building`/`needs_input`/`needs_approval`/`queued_resume`), overriding a `⏳` markdown status. So tapping **Build** (which inserts the job) moves the card to In progress — *accurate*, not just cosmetic. On a terminal job the card reverts to its markdown status (by then `✅`). `page.tsx` `effectiveStatus` only ever *promotes* planned→in_progress, never demotes a Shipped spec.
- ✅ **Instant client update:** on Build click, once the POST has inserted the (active) job, `BuildButton` calls `router.refresh()`, so the server board re-renders and the live overlay re-buckets the card into **In progress** right away — instant feedback from real DB state (well before the 4s `GET /api/roadmap/build` poll), no client-only guess that could drift from the server render. Same `router.refresh()` on Report-issue and Verify so those re-bucket too. `BuildButton.tsx` + the board column logic in `page.tsx`.

## Safety / invariants
- Markdown phase emojis stay the source of truth for *shipped*; the live overlay only **promotes** a spec to In progress while a build is active (never demotes a shipped spec).
- No DB schema change — reads existing `agent_jobs` (`getLatestJobsBySlug`).
- Optimistic move is UI-only; the real column follows the markdown/job state on reload.

## Completion criteria
- A spec with all phases ✅ shows **Shipped** even if its title emoji is stale (no more "done but Doing").
- Tapping **Build** on a Planned spec moves it to **In progress** immediately (optimistic) and stays there while the build runs (live job).
- `build-spec` leaves the H1 title consistent with the phases on completion.

## Verification
- On a spec whose every `## Phase` is `✅` but whose H1 title still carries `🚧` (e.g. craft a scratch `specs/_test-stale.md`, or use `worker-self-update` if still present), open `/dashboard/roadmap` → expect the card in the **Shipped — awaiting verification** column, not **In progress**.
- On a spec with a `❌` title and at least one `⏳`/`🚧` phase, open `/dashboard/roadmap` → expect it is **not** force-shipped (still shows by its phase mix) — the `❌` cut / no-phases exception still defers to the title.
- On `/dashboard/roadmap` as **owner**, tap **Build** on a card in **Planned** → expect the card to jump to the **In progress** column within ~1s (after the POST returns, via `router.refresh()`), showing a **Queued/Building…** chip — no manual reload.
- While that build runs (job `queued`→`building`→`needs_input`/`needs_approval`), reload `/dashboard/roadmap` → expect the card **stays** in **In progress** (live overlay reads the active `agent_jobs` row), even though `specs/{slug}.md` still says `⏳`.
- After the build completes + the PR merges + the next deploy flips the phases/title to `✅`, reload → expect the card now sits in **Shipped — awaiting verification** (job terminal → overlay reverts to markdown, which is now shipped).
- Run a `build-spec` build to completion on any spec → expect the resulting PR sets the H1 title emoji to `✅` (matching the all-`✅` phase set), not a leftover `🚧`.

## Related
[[roadmap-build-console]] · [[build-box-status-view]] · [[verification-guides]] · [[../dashboard/roadmap]] · [[../libraries/brain-roadmap]] · [[../tables/agent_jobs]]
