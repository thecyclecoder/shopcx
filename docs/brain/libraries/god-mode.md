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
| `openApproval(admin, args)` | Insert one `god_mode_approvals` row (`status='pending'`, `risk`). Called by the Phase-2 permission gate for every non-safe tool call. Returns the row. **No longer sends an SMS on insert** — the founder is texted only by the 5-min nudge below. |
| `getApproval(admin, id)` | Poll a single approval row (~2s cadence in the gate). |
| `decideApproval(admin, { approvalId, decision, questionText? })` | Terminal-flip one approval to `approved` / `denied` / `asked`. Idempotent (no-op if already terminal). `ask` requires `questionText`. |
| `openPlan(admin, { sessionId, workspaceId, title, steps? })` | **Plan-scoped approvals**: insert one `risk='plan'` row (`tool_name='Plan'`, `preview`=title+numbered steps) via `openApproval`. The founder approves this ONE card to authorize a whole unit of work. Driven by `scripts/god-mode-plan.ts open`. |
| `setActivePlan(admin, sessionId, planId \| null)` | Point [[../tables/god_mode_sessions]].`active_plan_id` at an approved plan (or clear it). Set on plan approval; cleared by `god-mode-plan.ts close` + at each turn start. |
| `getActivePlan(admin, sessionId)` | The session's currently-open plan row, or null — returns non-null ONLY if `active_plan_id` is set AND that row is `status='approved'` + `risk='plan'`. The [[god-mode-permission-gate]] calls it on every non-destructive call to decide auto-allow. |
| `hasInFlight(admin, sessionId)` | Phase-5 reaper check — does the session hold any `pending` approval? A `true` blocks the idle-disarm. |
| `isSessionArmed(admin, sessionId)` | Belt-and-suspenders check the gate uses to bail fast if the founder disarmed while a tool call was mid-flight. |
| `resolveCockpitToken(admin, token)` | Phase-3 chokepoint: resolve a `/god/[token]` slug to `{ kind: 'ok' \| 'not_found' \| 'disarmed' \| 'expired', session? }`. Every Phase-3 route calls this so 404 (unknown/disarmed) vs 410 (expired) is decided in one place. |
| `listApprovalsForSession(admin, sessionId, limit=50)` | Cockpit-render read — approvals for the session, most-recent first. |
| `getApprovalForSession(admin, { approvalId, sessionId })` | Tamper-guarded read: only returns the row if it belongs to THIS session. `null` otherwise — same shape as row-not-found so callers can't distinguish. |
| `loadPinHash(admin, workspaceId)` | Read `workspaces.god_mode_pin_hash`. Used by the Phase-3 approve route for the destructive-approval PIN check. |
| `enqueueGodModeTurn(admin, { workspaceId, sessionId, userMessage, createdBy? })` | Insert a `kind='god-mode'` `mode:'turn'` `agent_jobs` row. Called by `POST /api/god/[token]/message` and by the Phase-4 dashboard tab. |
| `resolveFounderPhone(admin, workspaceId)` | Phase-5 config resolver: `workspaces.god_mode_sms_number` first, then `process.env.GOD_MODE_FOUNDER_PHONE`. `null` means silent no-op (god mode still works, just no push). |
| `sendGodModeSMS(admin, { workspaceId, kind, cockpitToken?, context? })` | Phase-5 emit — best-effort, never throws. `kind: 'arm' \| 'approval' \| 'done'`. Called from `armSession` (arm), `nudgeStalePendingApprovals` (approval — the 5-min reminder, batched via `context.count`), `disarmSession` + `reapGodModeSessions` (done). Sends the persistent cockpit URL in arm + approval; done omits URL. Silent no-op when no founder phone or no workspace `twilio_phone_number`. |
| `nudgeStalePendingApprovals(admin)` | **5-min approval nudge** — one pass on the box-worker 60s beat. Texts ONCE (batched per session) for each ARMED session holding a `pending` approval older than `APPROVAL_NUDGE_AFTER_MS` (5 min) with `sms_notified_at IS NULL`, then stamps `sms_notified_at` so it never re-texts. Stamps-without-SMS a dead (disarmed/expired) session's leftover pendings; stamps only on delivered send otherwise (transient Twilio failure retries next beat). Returns `{ nudged }`. |
| `APPROVAL_NUDGE_AFTER_MS` | `5 * 60 * 1000` — the unanswered-approval threshold before the founder is texted. |
| `reapGodModeSessions(admin)` | Phase-5 reaper — one pass over `armed` rows. Force-disarms past `absolute_expires_at` (regardless of activity). Idle-expires past `token_expires_at` only when `hasInFlight===false` AND no queued/building `kind='god-mode'` `agent_jobs` row for the session. Emits a done SMS on expiry. Called from a ~60s beat in `scripts/builder-worker.ts` next to the stale-session reaper. |
| `GodModeSmsKind` / `TokenResolution` / `GodModeMessage` / `GodModeStatus` / `GodModeSessionRow` / `GodModeApprovalRow` / `GodModeApprovalRisk` / `GodModeApprovalStatus` | Types. |

## Callers

- `POST /api/god-mode/arm` — owner-gated. Calls `armSession` + returns `cockpit_url`.
- `POST /api/god-mode/disarm` — owner-gated OR cockpit-token authed. Calls `disarmSession`.
- `scripts/_set-god-mode-pin.ts` — disposable, env-fed. Calls `hashPin` to store ONLY the hash.
- `scripts/builder-worker.ts` `runGodModeJob` — turn runner. Calls `disarmSession` (kill mode), `appendMessage`, `setBoxSession`, `bumpActivity`.
- `scripts/god-mode-permission-gate.ts` — the box-side PreToolUse hook. Calls `isSessionArmed`, `openApproval`, `getApproval` in a poll loop.
- `GET /api/god/[token]` — calls `resolveCockpitToken`, `listApprovalsForSession`, `bumpActivity`.
- `POST /api/god/[token]/message` — calls `resolveCockpitToken`, `appendMessage`, `enqueueGodModeTurn`, `bumpActivity`.
- `POST /api/god/[token]/approve` — calls `resolveCockpitToken`, `getApprovalForSession`, `loadPinHash` + `verifyPin` (destructive), `decideApproval`, `bumpActivity`.
- Phase 4 dashboard tab — calls the owner-gated `/api/god-mode/*` routes; each route resolves the workspace's active session server-side.
- `scripts/builder-worker.ts` reaper beat — calls `reapGodModeSessions(db)` every ~60s.

## RLS + safety

All exported writes assume the caller passes a service-role client (`createAdminClient()`) — the tables are service-role-only ([[../tables/god_mode_sessions]] / [[../tables/god_mode_approvals]]). The PIN plaintext is only ever in memory inside `hashPin` / `verifyPin`; never persisted, never logged.

## CEO-grade model additions (2026-07)

New SDK surface for the CEO-grade approval model ([[../lifecycles/god-mode]] § CEO-grade approval model):

- **Decisions:** `openDecision` (raise a plain-language `risk='decision'` card), `plainApprovalLabel` + `logApprovalDecision` (log the founder's decision back into the chat).
- **Standing grants ("don't ask again"):** `isCategoryStandingGranted`, `listStandingGrants`, `grantStanding`, `revokeStanding`, `normalizeCategory` (over [[../tables/god_mode_standing_grants]]). Only `risk='decision'` cards are grantable — the destructive floor never is.
- **Live checklist + notes:** `startChecklist` / `checklistStep` / `finishChecklist` (a `role='checklist'` transcript message the box updates in place) + `appendNote` (a plain confirmation line). Driven by `scripts/god-mode-progress.ts`.
- `openApproval` gained an optional `category`; `GodModeApprovalRow` gained `category`; `GodModeMessage.role` gained `checklist`; `GodModeApprovalRisk` gained `decision`.

The box escalates decisions via `scripts/god-mode-plan.ts decide "<category>" "<question>"` (checks the standing grant, else raises + polls a decision card). The double-print fix lives in the worker (`runGodModeJob` no longer re-appends the founder message — the message route already did).

## God-mode becomes CEO's executive-assistant agent (Phase 8)

[[../lifecycles/god-mode#autonomous-executive-assistant--god-mode-becomes-ceos-agent-phase-8]] phases the cockpit into a **first-class autonomous agent** under the CEO seat with its own identity — 🌙 **Eve** (the founder's executive assistant). The SDK stays unchanged; the org model + liveness wiring changed:

**Phase 1:** Extended `OwnerFunction` enum to include `'ceo'` (previously directors only). Registered `god-mode-cockpit` as a MONITORED_LOOPS `reactive` lane with `owner="ceo"` + `personaKind="god-mode"` (see [[../libraries/control-tower]] registry), giving the cockpit a CEO owner instead of Platform-defaulting. Added Eve to [[../libraries/agent-personas]] personas.ts — name: "Eve", role: "Executive Assistant", pronouns she/her/her, personality describing a phone-to-box assistant that does anything within the founder's gates.

**Phase 2:** [[../libraries/agent-personas]] `org-chart.ts` now renders CEO-owned workers under the CEO seat alongside goals (lines 413–418) — filtered from the same roster that fills directors' workers, so a lane renders in exactly one place. Liveness for Eve derives from cockpit `armed` [[../tables/god_mode_sessions]] rows (healthy when armed, even idle) + `loop_heartbeats` for the `god-mode-cockpit` loop + recent `god_mode_approvals` (a pending approval holds liveness open). The cockpit is event-driven, but liveness is beats-based so the roster dashboard never breaks.

**Phase 3 Fix 1:** Pre-merge spec-test regression (check 3122218882ab4f64) required Eve to have a "real avatarUrl" (not null). Fixed by the companion spec `builder-persona-add-upserts-by-key-and-generates-avatar` ✅ — the builder now auto-generates a Nano Banana Pro headshot for Eve and all agent personas on the persona-add step, uploading to the `agent-avatars` bucket with a `?v=` query stamp.

## Founder-phone reuse — external founder-alert emitters

`resolveFounderPhone` is the shared reader for the founder's mobile ([[../tables/workspaces]] `god_mode_sms_number` → `GOD_MODE_FOUNDER_PHONE` env fallback). External flows that need to text the founder OUTSIDE the god-mode session lifecycle reuse it (paired with [[../integrations/twilio]] `sendSMS`) rather than adding a new phone-resolution surface. Current external emitters:

| Emitter | Trigger | Idempotency | Spec |
|---|---|---|---|
| `src/lib/commerce/founder-cancel-sms.ts` `sendFounderCancelAmplifierSMS` | Sol classifies an OOS renewal as `crisis_swap_rejected` and the order is not yet Shipped in Amplifier → text the founder to cancel it manually before it ships (Amplifier exposes no cancel API). Best-effort, never-throws, Shipped-guarded. | `customer_events` row of `event_type='order.founder_cancel_amplifier_sms_sent'` scoped by `(workspace_id, properties.order_id)` — durable ledger, same order never gets two texts. Ledger stamped ONLY on delivered SMS so a transient Twilio failure retries. | [[../specs/sol-crisis-swap-rejected-full-refund-and-sms-founder-to-cancel-amplifier-order]] Phase 2 |

The `sendGodModeSMS` inside this SDK stays reserved for the god-mode session lifecycle (arm / 5-min approval nudge / done). External founder alerts get their own module so their idempotency ledger, kind vocabulary, and best-effort discipline don't leak into the god-mode approval nudge state machine.
