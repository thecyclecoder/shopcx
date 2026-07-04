# god_mode_sessions

The founder's ELEVATED bridge to the box. One row per god-mode session (armed, disarmed, or expired). Extends the box-session pattern proven by [[../dashboard/developer__messages]] into a LIVE, prod-writable lane that runs `claude -p` against the target repo under a hard per-tool permission gate. See [[../specs/god-mode]] · [[../lifecycles/god-mode]] · [[../functions/ceo]].

**North-star (supervisable autonomy):** god-mode is the founder's MANUAL full-power supervisor bridge — deliberately a sunset stopgap until the autonomous CEO exec layer can self-remediate. Every tool call the box makes routes through the founder's approval (Phase 2 [[../lifecycles/god-mode]]) — never a silent proxy-optimizer.

**Design:** a distinct ENTITY (not a flag on any existing session table) because it carries its own approval queue ([[god_mode_approvals]]), its own token-authed cockpit ([[../lifecycles/god-mode]] § cockpit), and its own idle/hard-ceiling lifecycle.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `created_by` | `uuid` | — | The `auth.users.id` of the owner who armed the session. Kept for audit. Only `workspace_members.role='owner'` can arm (enforced in `POST /api/god-mode/arm` via `requireOwner`). |
| `status` | `text` | — | default `'armed'` · CHECK ∈ `armed` \| `disarmed` \| `expired`. See lifecycle below. |
| `cockpit_token` | `text` | ✓ | 48-char hex (24 random bytes, `randomBytes(24).toString('hex')` — same size as [[journey_sessions]].token). The `/god/{token}` slug. NULLED on disarm/expire so a stale slug can't reach a dead session. UNIQUE across live tokens via a partial index. |
| `token_expires_at` | `timestamptz` | ✓ | Sliding TTL. Every GET/message/approve/turn bumps this forward `~20min` (SLIDING_TTL_MS in [[../libraries/god-mode]]). The Phase-5 reaper expires an idle session when `now() > token_expires_at` AND nothing is in-flight. |
| `absolute_expires_at` | `timestamptz` | ✓ | Hard ceiling — arm() + 12h. Independent of activity; the Phase-5 reaper force-disarms past this regardless of what's in flight. Founder re-arms with one tap. |
| `box_session_id` | `text` | ✓ | Captured from the `claude -p` stream after each turn so subsequent turns pass `--resume`. Pins the session to its Max account (same discipline as [[agent_jobs]].`claude_session_id`). |
| `box_session_config_dir` | `text` | ✓ | Paired with `box_session_id` — the `--config-dir` the `--resume` needs (mirrors `agent_jobs.claude_session_config_dir`). |
| `messages` | `jsonb` | — | default `'[]'`. Transcript. Shape: `[{ role: 'user'\|'assistant'\|'system', content: string, ts: string }]`. Same convention as [[dev_message_threads]].messages — the cockpit + dashboard render straight off this array. |
| `last_activity_at` | `timestamptz` | — | default `now()`. Phase-5 in-flight signal AND liveness bump — every GET/message/approve pushes this forward alongside `token_expires_at`. Distinct from `token_expires_at` so the reaper can distinguish "idle but not yet expired" from "recently active". |
| `armed_at` | `timestamptz` | — | default `now()`. When arm() minted the current token — reset on re-arm. |
| `disarmed_at` | `timestamptz` | ✓ | Stamped when status flips to `disarmed` or `expired`. |
| `created_at` | `timestamptz` | — | default `now()`. First-arm timestamp — never reset. |
| `active_plan_id` | `uuid` | ✓ | → [[god_mode_approvals]].id · ON DELETE SET NULL. **Plan-scoped approvals** (hotfix): the currently-open, founder-approved plan. While non-NULL AND that approval row is `status='approved'` + `risk='plan'`, the box gate AUTO-ALLOWS non-destructive tool calls (the founder approved the DECISION once, not each keystroke). Set by `scripts/god-mode-plan.ts open` on approval; nulled by `close` AND at the start of every turn (a plan authorizes work only within the turn it was approved in). Destructive calls NEVER batch under a plan — they still PIN-gate individually. |

**Indexes:**
- `god_mode_sessions_cockpit_token_key` — UNIQUE partial `(cockpit_token) where cockpit_token is not null`. Hot path for every `/api/god/[token]` request. Many NULLs are OK (disarmed sessions null the token).
- `god_mode_sessions_workspace_armed_uniq` — UNIQUE partial `(workspace_id) where status='armed'`. Enforces the ONE-ACTIVE-SESSION-PER-WORKSPACE invariant. Enables arm() upsert.
- `god_mode_sessions_reaper_idx` — `(status, token_expires_at) where status='armed'`. Phase-5 reaper scan.

## Lifecycle (`status`)

- **armed** — arm() minted a fresh `cockpit_token`, set the sliding + absolute TTLs. The `/god/{token}` cockpit is live; the box can drive turns.
- **disarmed** — the founder tore it down (owner-gated `/api/god-mode/disarm`, or from the cockpit token). Sets `cockpit_token=NULL` and stamps `disarmed_at`. Idempotent.
- **expired** — the Phase-5 reaper closed it (idle past `token_expires_at` with no in-flight signal, OR past `absolute_expires_at` regardless). Same terminal state as `disarmed` — cockpit token nulled, `disarmed_at` stamped.

Only `armed` is queryable via the cockpit; `disarmed`/`expired` return `404`/`410` at `/api/god/[token]`.

## Chokepoint

All WRITES go through [[../libraries/god-mode]] (`armSession` / `disarmSession` / `getActiveSession` / `getSessionByToken` / `setActivePlan` / `getActivePlan`) via `createAdminClient()`. No raw `.from('god_mode_sessions').insert|update|delete` outside the SDK — same discipline as [[../libraries/specs-table]] / [[../libraries/goals-table]] / [[../libraries/lander-blueprints]].

## RLS

Service-role only. Neither the cockpit nor the dashboard tab reads via authenticated end-user policies — the cockpit is token-authed via a service-role route (matches [[journey_sessions]]) and the dashboard tab reads via the owner-gated `/api/god-mode/*` server routes.

## Related

- [[god_mode_approvals]] — the approvals queue+history for a session.
- [[workspaces]].`god_mode_pin_hash` — the founder PIN (one-way scrypt hash; plaintext never in DB).
- [[../lifecycles/god-mode]] — end-to-end trace of arm → cockpit → box → approval → disarm.
- [[../specs/god-mode]] — the spec this table implements.
