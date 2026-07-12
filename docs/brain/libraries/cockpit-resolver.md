# `src/lib/cockpit-resolver.ts` — the single `/god/[token]` cockpit chokepoint

The one place the `/god/[token]` routes call to decide **WHICH cockpit backs a 48-hex token**. Landed with the per-director SMS cockpit (M4 of the [[../lifecycles/director-cockpits]] goal) so that Eve's phone cockpit and every director's phone cockpit share ONE URL surface without their token spaces ever colliding.

**File:** `src/lib/cockpit-resolver.ts` (server-only — imports the two mint/resolve helpers)

## Exports
- **`resolveCockpitTokenAny(admin, token)`** → `CockpitResolution | null`. Resolves a token to its backing surface:
  - `{ kind: 'god', session }` — Eve's cockpit, from [[god-mode]] `resolveCockpitToken` ([[../tables/god_mode_sessions]]).
  - `{ kind: 'director', thread }` — a per-director SMS cockpit, from [[director-coach-threads]] `resolveDirectorCockpitToken` ([[../tables/director_coach_threads]]).
  - `null` — one terminal rejection collapsing every failure mode: wrong-length/empty token (rejected before any DB call), unknown in both tables, past a sliding OR absolute TTL, or a god session not `armed`.
- **`CockpitResolution`** type — the tagged union above.

## Why order matters
`god_mode_sessions` is checked **first** so Eve's pre-existing cockpit path stays **byte-for-byte unchanged** for every already-armed token; only a god not-found falls through to `director_coach_threads`. The two token spaces are DISJOINT by construction — a unique-per-token index on each table + disjoint mint helpers guarantee a token resolves in at most one table — so the ordering is a safety belt, not a tie-breaker.

## The invariant the routes must obey
The `/god/[token]` route (`route.ts` / `message/route.ts` / `approve/route.ts`) **MUST branch on the returned `kind`** and never assume `god` — a director cockpit runs the read-only `max` sandbox bound to that director's leash and PIN-gates only the same rails the in-app chat does; it can never reach an Eve/`godmode` power. See [[../lifecycles/director-cockpits]] § SMS cockpit.

## North star
Two supervisors (the CEO via Eve; a director via its leash) reachable from one phone URL, with a code-level guarantee that a director token can't silently become god-mode — the resolver is where the leash boundary is enforced, not where it's hoped for ([[../operational-rules]] § North star).

---

[[../README]] · [[god-mode]] · [[director-coach-threads]] · [[../tables/god_mode_sessions]] · [[../tables/director_coach_threads]] · [[../lifecycles/director-cockpits]] · [[../lifecycles/god-mode]] · [[../../CLAUDE]]
