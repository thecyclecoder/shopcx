# Roadmap status accuracy — phase-consensus + live-job board status ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

The board's column for a spec is derived purely from its markdown emojis, and two gaps make it lie:
1. **Stale title wins over done phases.** `deriveStatus` lets the H1 title emoji override the phases — so a spec with **all phases ✅** but a forgotten **🚧 title** shows as "Doing" even though it shipped + merged (observed: `worker-self-update`).
2. **No optimistic / live status.** Hitting **Build** on a Planned spec doesn't move it — the card sits in Planned until the build flips the emoji and the next deploy re-reads it. It should jump to **In progress** immediately.

Make the board reflect reality: phase consensus + the live `agent_jobs` state.

## Phase 1 — Phase consensus beats a stale title ⏳
- ⏳ `src/lib/brain-roadmap.ts` `deriveStatus`: when **all phases are ✅** (none `⏳`/`🚧`, not title-`❌`), the spec is **shipped** regardless of the H1 title emoji — a forgotten title no longer overrides a done phase set. (Title still wins for explicit `❌` cut / when there are no phases.)
- ⏳ `build-spec` skill: on completion, **flip the H1 title emoji to match** the phase consensus (`✅` when all phases ship), so the markdown is self-consistent too — belt-and-suspenders with the parser fix.

## Phase 2 — Optimistic + live-job status ⏳
- ⏳ **Live overlay:** the board renders a spec as **In progress** when it has an **active `agent_jobs`** row (`queued`/`claimed`/`building`/`needs_input`/`needs_approval`/`queued_resume`), overriding a `⏳` markdown status. So tapping **Build** (which inserts the job) moves the card to In progress within one poll — *accurate*, not just cosmetic. On a terminal job the card reverts to its markdown status (by then `✅`).
- ⏳ **Optimistic client update:** on Build click, immediately move the card to the In progress column (before the poll confirms) for instant feedback; reconcile on the next `GET /api/roadmap/build` poll. `BuildButton.tsx` + the board column logic in `page.tsx`.

## Safety / invariants
- Markdown phase emojis stay the source of truth for *shipped*; the live overlay only **promotes** a spec to In progress while a build is active (never demotes a shipped spec).
- No DB schema change — reads existing `agent_jobs` (`getLatestJobsBySlug`).
- Optimistic move is UI-only; the real column follows the markdown/job state on reload.

## Completion criteria
- A spec with all phases ✅ shows **Shipped** even if its title emoji is stale (no more "done but Doing").
- Tapping **Build** on a Planned spec moves it to **In progress** immediately (optimistic) and stays there while the build runs (live job).
- `build-spec` leaves the H1 title consistent with the phases on completion.

## Related
[[roadmap-build-console]] · [[build-box-status-view]] · [[verification-guides]] · [[../dashboard/roadmap]] · [[../libraries/brain-roadmap]] · [[../tables/agent_jobs]]
