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
| `appendMessage(admin, sessionId, message)` | Read-modify-write one entry onto the transcript. Bumps `last_activity_at` (Phase-5 in-flight signal). |
| `setBoxSession(admin, sessionId, { boxSessionId, boxSessionConfigDir })` | Capture the Claude session id + config dir after a turn so the next turn `--resume`'s cleanly and pins to the SAME Max account. |
| `bumpActivity(admin, sessionId)` | Slide `token_expires_at` forward `SLIDING_TTL_MS` + touch `last_activity_at`. Called on every GET/message/approve/turn line. |
| `openApproval(admin, args)` | Insert one `god_mode_approvals` row (`status='pending'`, `risk`). Called by the Phase-2 permission gate for every non-safe tool call. Returns the row. |
| `getApproval(admin, id)` | Poll a single approval row (~2s cadence in the gate). |
| `decideApproval(admin, { approvalId, decision, questionText? })` | Terminal-flip one approval to `approved` / `denied` / `asked`. Idempotent (no-op if already terminal). `ask` requires `questionText`. |
| `hasInFlight(admin, sessionId)` | Phase-5 reaper check — does the session hold any `pending` approval? A `true` blocks the idle-disarm. |
| `isSessionArmed(admin, sessionId)` | Belt-and-suspenders check the gate uses to bail fast if the founder disarmed while a tool call was mid-flight. |
| `resolveCockpitToken(admin, token)` | Phase-3 chokepoint: resolve a `/god/[token]` slug to `{ kind: 'ok' \| 'not_found' \| 'disarmed' \| 'expired', session? }`. Every Phase-3 route calls this so 404 (unknown/disarmed) vs 410 (expired) is decided in one place. |
| `listApprovalsForSession(admin, sessionId, limit=50)` | Cockpit-render read — approvals for the session, most-recent first. |
| `getApprovalForSession(admin, { approvalId, sessionId })` | Tamper-guarded read: only returns the row if it belongs to THIS session. `null` otherwise — same shape as row-not-found so callers can't distinguish. |
| `loadPinHash(admin, workspaceId)` | Read `workspaces.god_mode_pin_hash`. Used by the Phase-3 approve route for the destructive-approval PIN check. |
| `enqueueGodModeTurn(admin, { workspaceId, sessionId, userMessage, createdBy? })` | Insert a `kind='god-mode'` `mode:'turn'` `agent_jobs` row. Called by `POST /api/god/[token]/message` and by the Phase-4 dashboard tab. |
| `TokenResolution` / `GodModeMessage` / `GodModeStatus` / `GodModeSessionRow` / `GodModeApprovalRow` / `GodModeApprovalRisk` / `GodModeApprovalStatus` | Types. |

## Callers

- `POST /api/god-mode/arm` — owner-gated. Calls `armSession` + returns `cockpit_url`.
- `POST /api/god-mode/disarm` — owner-gated OR cockpit-token authed. Calls `disarmSession`.
- `scripts/_set-god-mode-pin.ts` — disposable, env-fed. Calls `hashPin` to store ONLY the hash.
- `scripts/builder-worker.ts` `runGodModeJob` — turn runner. Calls `disarmSession` (kill mode), `appendMessage`, `setBoxSession`, `bumpActivity`.
- `scripts/god-mode-permission-gate.ts` — the box-side PreToolUse hook. Calls `isSessionArmed`, `openApproval`, `getApproval` in a poll loop.
- `GET /api/god/[token]` — calls `resolveCockpitToken`, `listApprovalsForSession`, `bumpActivity`.
- `POST /api/god/[token]/message` — calls `resolveCockpitToken`, `appendMessage`, `enqueueGodModeTurn`, `bumpActivity`.
- `POST /api/god/[token]/approve` — calls `resolveCockpitToken`, `getApprovalForSession`, `loadPinHash` + `verifyPin` (destructive), `decideApproval`, `bumpActivity`.
- Phase 4 dashboard tab — will call the same routes without the token (server-side resolves the workspace's active session).

## RLS + safety

All exported writes assume the caller passes a service-role client (`createAdminClient()`) — the tables are service-role-only ([[../tables/god_mode_sessions]] / [[../tables/god_mode_approvals]]). The PIN plaintext is only ever in memory inside `hashPin` / `verifyPin`; never persisted, never logged.
