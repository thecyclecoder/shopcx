# `src/lib/god-mode.ts` — god-mode session SDK + PIN hashing

The write chokepoint for [[../tables/god_mode_sessions]] and (Phase 2+) [[../tables/god_mode_approvals]]. Phase 1 of [[../specs/god-mode]]. See [[../lifecycles/god-mode]] · [[../functions/ceo]].

**North-star (supervisable autonomy):** god-mode is the founder's manual full-power supervisor bridge to the box. This file NEVER acts — it's the chokepoint the arm/disarm routes, the Phase-2 permission gate, the Phase-3 cockpit routes, and the Phase-4 dashboard tab call through so no raw `.from('god_mode_sessions'|'god_mode_approvals').insert|update` lives outside one enforced surface.

## Exports

| Export | Notes |
|---|---|
| `armSession(admin, { workspaceId, createdBy })` | Arm a session. Idempotent w.r.t. "one active session per workspace" — if an armed row already exists it REFRESHES the cockpit_token + resets both TTLs; else INSERTS a fresh row with `status='armed'`, a new 48-hex `cockpit_token`, `token_expires_at = now() + SLIDING_TTL_MS`, `absolute_expires_at = now() + ABSOLUTE_TTL_MS`. Returns the freshly-written row. |
| `disarmSession(admin, { workspaceId?, sessionId? })` | Disarm the workspace's active session (or a specific session by id). Sets `status='disarmed'`, `cockpit_token=NULL`, stamps `disarmed_at`. Idempotent — a session already disarmed/expired returns `null` unchanged. |
| `getActiveSession(admin, workspaceId)` | Load the workspace's `status='armed'` session, or `null`. |
| `getSessionByToken(admin, token)` | Load a session by its 48-char `cockpit_token`. Returns `null` for wrong-length or unknown token — the caller (the Phase-3 cockpit route) additionally checks `status='armed'` + TTLs before serving. |
| `newCockpitToken()` | Mint a 48-char hex cockpit token (`randomBytes(24).toString('hex')` — matches [[journey_sessions]].token size). |
| `cockpitUrl(token)` | Compose `${NEXT_PUBLIC_SITE_URL}/god/${token}`. Same convention as journey-delivery. |
| `hashPin(pin)` | Scrypt-hash a PIN for storage on [[../tables/workspaces]].`god_mode_pin_hash`. Format: `scrypt:v1:<saltHex>:<hashHex>`. 16-byte salt, `N=2^15, r=8, p=1, keylen=32`. |
| `verifyPin(candidate, stored)` | Constant-time PIN verify. Parses the stored `scrypt:v1:<salt>:<hash>` string, re-derives, compares via `timingSafeEqual`. Returns `false` on missing/malformed stored value — never leaks validity beyond allow/deny. |
| `SLIDING_TTL_MS` | 20 minutes. Sliding-TTL bump for the cockpit token — every Phase-3 GET/message/approve + every Phase-2 box turn extends `token_expires_at` this far. |
| `ABSOLUTE_TTL_MS` | 12 hours. Hard ceiling for `absolute_expires_at`. Never bumped. |
| `GodModeMessage` / `GodModeStatus` / `GodModeSessionRow` | Types. |

## Callers

- `POST /api/god-mode/arm` — owner-gated. Calls `armSession` + returns `cockpit_url`.
- `POST /api/god-mode/disarm` — owner-gated OR cockpit-token authed. Calls `disarmSession`.
- `scripts/_set-god-mode-pin.ts` — disposable, env-fed. Calls `hashPin` to store ONLY the hash.
- Phase 2+ box permission gate — will call `getSessionByToken` + a new `openApproval` / `decideApproval` pair (this file is the chokepoint they land under).

## RLS + safety

All exported writes assume the caller passes a service-role client (`createAdminClient()`) — the tables are service-role-only ([[../tables/god_mode_sessions]] / [[../tables/god_mode_approvals]]). The PIN plaintext is only ever in memory inside `hashPin` / `verifyPin`; never persisted, never logged.
