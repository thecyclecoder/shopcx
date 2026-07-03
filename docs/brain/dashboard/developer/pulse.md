# Dashboard · developer/pulse

Read-only founder-only context-reconstitution surface. Renders the five lenses synthesized by [[../../libraries/pulse]] — with each claim showing its cite (spec detail page / commit / session digest).

**Route:** `/dashboard/developer/pulse`

**File:** `src/app/dashboard/developer/pulse/page.tsx`

## What it renders

Five lenses from the latest [[../../tables/pulse_snapshots]] snapshot:
1. **What's working** — shipped specs + resolved threads
2. **Where you left off** — open threads not yet matched to a spec
3. **On the horizon** — planned specs from the ledger
4. **In review** — specs awaiting disposition
5. **Backlog signal** — deferral reasons (noise/non-work)

Each claim carries a superscript cite link to its source.

## Controls

**Refresh button** — calls `/api/developer/pulse?refresh=1` to recompute the snapshot and update the `synthesized_at` timestamp.

## Access control

- Owner-only (founder)
- Non-owner requests receive a 403 Forbidden

## API endpoint

[[../../api/developer/pulse]] (owner-gate, caches into [[../../tables/pulse_snapshots]], returns latest snapshot with synthesized-at)

## Related

[[../developer]] · [[../../libraries/pulse]] · [[../../tables/pulse_snapshots]] · [[../../tables/pulse_session_digests]] · [[../../functions/platform]] · [[../../goals/ceo-mode]]
