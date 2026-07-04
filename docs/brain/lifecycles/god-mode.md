# god-mode

The founder's ELEVATED bridge to the box for incident remediation. A deliberate **sunset stopgap** — the manual full-power founder bridge to the box while the autonomous CEO/director exec layer doesn't yet exist. Retired once the CEO-mode exec layer can self-remediate. See [[../specs/god-mode]] · [[../functions/ceo]] · [[../tables/god_mode_sessions]] · [[../tables/god_mode_approvals]].

## North-star (supervisable autonomy)

God-mode is the founder's **manual supervisor** bridge over a full-power box session. Every mutation the box makes is COUNTER-SIGNED by the founder via [[../tables/god_mode_approvals]] — never a silent proxy-optimizer. When the CEO exec layer can carry this supervision itself, god-mode retires.

## What's in the same PR (Phase 1)

- **Migration** — `supabase/migrations/20260908120000_god_mode_sessions_and_approvals.sql` creates [[../tables/god_mode_sessions]] + [[../tables/god_mode_approvals]] + adds `workspaces.god_mode_pin_hash` (see below). Applied via `scripts/apply-god-mode-sessions-migration.ts`.
- **SDK chokepoint** — [[../libraries/god-mode]] (`src/lib/god-mode.ts`): `armSession`, `disarmSession`, `getActiveSession`, `getSessionByToken`, `newCockpitToken`, `cockpitUrl`, `hashPin`, `verifyPin`, `SLIDING_TTL_MS`, `ABSOLUTE_TTL_MS`.
- **Arm/disarm routes** — `POST /api/god-mode/arm` (owner-gated, returns the `/god/{token}` URL) + `POST /api/god-mode/disarm` (owner-gated OR cockpit-token authed).
- **Disposable PIN setter** — `scripts/_set-god-mode-pin.ts`. Reads the PIN from env, scrypt-hashes via `hashPin`, writes ONLY the hash to `workspaces.god_mode_pin_hash`. The plaintext PIN never enters source, never enters the DB, never enters shell history (recommended invocation: `read -s GOD_MODE_PIN && export GOD_MODE_PIN && WORKSPACE_ID=<uuid> npx tsx scripts/_set-god-mode-pin.ts && unset GOD_MODE_PIN`).

## Arm/disarm flow (Phase 1)

```
Owner taps 'Arm' in dashboard (Phase 4) — or POSTs /api/god-mode/arm directly
  → requireOwner (workspace_members.role='owner')
  → armSession(admin, { workspaceId, createdBy })
      → if an armed session already exists: REFRESH cockpit_token + reset TTLs
        (one-active-session-per-workspace enforced by a partial UNIQUE index)
      → else: INSERT { status='armed', cockpit_token: 48-hex, token_expires_at: +20min,
                       absolute_expires_at: +12h }
  → response: { cockpit_url: `${SITE_URL}/god/${cockpit_token}` }

Founder taps 'Disarm' (or the cockpit's kill switch)
  → POST /api/god-mode/disarm
      → cockpit_token in body? auth is the token itself (no cookie required)
      → else: requireOwner + workspaces.active session
  → disarmSession → status='disarmed', cockpit_token=NULL, disarmed_at=now()
  → Phase 2+ box lane sees the flip and tears down its `claude -p` session.
```

## Session model

One [[../tables/god_mode_sessions]] row per session. `status ∈ armed|disarmed|expired`. `armed` is enforced UNIQUE per `workspace_id` (partial UNIQUE index). See the table page for column details.

## Tokens & TTLs

- `cockpit_token` — 48-char hex, minted by `newCockpitToken()`, matches the [[journey_sessions]] token size. UNIQUE across live tokens; NULLED on disarm/expire.
- `token_expires_at` — SLIDING. Every Phase-3 GET/message/approve + every Phase-2 box turn bumps this forward `SLIDING_TTL_MS` (~20min). The Phase-5 reaper expires idle sessions past this WITH no in-flight signal.
- `absolute_expires_at` — HARD ceiling. `arm() + 12h`. Never bumped. The Phase-5 reaper force-disarms past this regardless of activity.
- `last_activity_at` — separate liveness bump; distinguishes "idle but not yet expired" from "recently active" for the reaper.

## Founder PIN

Stored ONLY as a one-way scrypt hash on [[../tables/workspaces]].`god_mode_pin_hash`:

- Format: `scrypt:v1:<saltHex>:<hashHex>` — 16-byte random salt, `N=2^15, r=8, p=1, keylen=32`.
- Hashed by [[../libraries/god-mode]] `hashPin(pin)` — takes plaintext ONLY in memory.
- Verified by `verifyPin(candidate, stored)` — constant-time (`timingSafeEqual`); no plaintext compare, no leak on mismatch beyond allow/deny.
- Set OUT-OF-BAND via `scripts/_set-god-mode-pin.ts` (env-fed, disposable, `_`-prefix / do-not-ship convention).
- USED in Phase 3 — approving a `risk='destructive'` [[../tables/god_mode_approvals]] row requires a valid PIN before flipping `status` to `approved`.

## Phase 2+ — deliberately out of scope for this PR

Phase 2 (full-power box lane + live permission gate), Phase 3 (cockpit token page + Chat + Approvals tabs), Phase 4 (in-app tab), Phase 5 (SMS + reaper) all build on this state model. See the individual phases in [[../specs/god-mode]]. The tables + SDK + arm/disarm here are wired to make ALL of them land cleanly — the approvals table has the shape Phase 2's gate needs, the tokens have the shape Phase 3's cockpit needs, the sliding/absolute TTLs have the shape Phase 5's reaper needs.

## Sunset

Retire the whole feature (drop the two tables + the workspaces column + delete `src/lib/god-mode.ts` + delete the routes) once the CEO exec layer covers the incident remediation surface. Self-contained by construction (no shared tables, no shared columns beyond one workspaces column) — removal is a one-migration + one-PR cleanup.

## Status / open work

- Phase 1 (session model + arm/disarm + PIN): ✅ shipped.
- Phase 2 (full-power box lane + live permission gate): ⏳ planned.
- Phase 3 (SMS cockpit — token page with Chat + Approvals tabs): ⏳ planned.
- Phase 4 (in-app dashboard God Mode tab): ⏳ planned.
- Phase 5 (SMS delivery + lifecycle reaper): ⏳ planned.
