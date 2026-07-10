# god_mode_approvals

The approvals queue+history for a [[god_mode_sessions]] session. One row per BLOCKED tool call the Phase-2 permission gate had to route to the founder — a `Write`/`Edit`, a non-allowlisted `Bash`, a migration apply, a `git push`, a destructive DDL. See [[../specs/god-mode]] · [[../lifecycles/god-mode]] · [[../functions/ceo]].

**North-star (supervisable autonomy):** every mutation the box makes under god-mode is COUNTER-SIGNED by the founder — but at the granularity of a DECISION, not a keystroke. A call is either (a) on the safe-read allowlist → skips the table, (b) covered by an approved open `plan` (the founder counter-signed the whole unit of work — see [[god_mode_sessions]].`active_plan_id`) → auto-allowed, or (c) lands a row here and blocks until the founder decides. Supervisability is preserved even under a plan: destructive calls STILL gate individually with the PIN, the Chat tab streams every call live, and disarm tears the session down mid-flight.

**Design:** DELIBERATELY its own table — NOT [[agent_jobs]].`pending_actions` — because god-mode uses a LIVE in-session gate (poll → allow/deny) rather than the propose-then-worker-executes model. Self-contained also means cleanly removable when the CEO exec layer retires this stopgap.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `session_id` | `uuid` | — | → [[god_mode_sessions]].id · ON DELETE CASCADE |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE. Denormalized for fast per-workspace history + audit queries; ALWAYS mirrors `session.workspace_id`. |
| `tool_name` | `text` | — | The blocked tool — `Bash`, `Edit`, `Write`, `ApplyMigration`, etc. Free-text; vocabulary is the Claude Code PreToolUse contract (Phase 2). |
| `tool_input` | `jsonb` | — | The raw tool input the gate saw (command string, edit patch, migration SQL). Shape varies per `tool_name`. |
| `preview` | `text` | — | Human-readable single-string preview the cockpit renders on the approval card. The gate synthesizes this from `tool_input` (the command line, the diff summary, the migration filename). Never null — the founder needs SOMETHING to decide on. |
| `risk` | `text` | — | default `'write'` · CHECK ∈ `safe` \| `write` \| `destructive` \| `plan` \| `decision`. CEO-grade model ([[../lifecycles/god-mode]]): `decision` = a box-raised plain-language CEO call (standing-grantable); `destructive` = the deterministic catastrophic floor (always PIN, never grantable); `safe`/`write`/`plan` are legacy tiers (the gate no longer raises them — it allows all non-catastrophic work). |
| `category` | `text` | ✓ | The plain-language category a `risk='decision'` card belongs to (e.g. `dismiss-stale-approvals`, `ship-hotfix`). Keyed on by [[god_mode_standing_grants]] — "don't ask again" grants this category so future decisions in it auto-approve. NULL for non-decision rows. |
| `status` | `text` | — | default `'pending'` · CHECK ∈ `pending` \| `approved` \| `denied` \| `asked`. Decision lifecycle (see below). |
| `question_text` | `text` | ✓ | Populated only on `status='asked'` — the founder's question back to the box. |
| `decided_at` | `timestamptz` | ✓ | Stamped when status leaves `pending`. |
| `created_at` | `timestamptz` | — | default `now()` |
| `sms_notified_at` | `timestamptz` | ✓ | When the **5-min nudge SMS** fired for this row (NULL = not yet nudged). The founder is NOT texted on insert anymore — only if a card sits `pending` unanswered for `APPROVAL_NUDGE_AFTER_MS` (5 min). The 60s `nudgeStalePendingApprovals` sweep ([[../libraries/god-mode]]) stamps this so it never re-texts the same rows. See [[../lifecycles/god-mode]] § Phase 5. |

**Indexes:**
- `god_mode_approvals_gate_poll_idx` — `(id, status)`. Hot path — the Phase-2 gate's poll loop.
- `god_mode_approvals_session_created_idx` — `(session_id, created_at desc)`. Cockpit render (pending at top, history below).
- `god_mode_approvals_workspace_created_idx` — `(workspace_id, created_at desc)`. Workspace-wide audit.

## `risk` classification

- **safe** — reserved. In practice safe reads (Read/Grep/Glob/WebSearch + allowlisted read-only Bash prefixes) AUTO-ALLOW without hitting this table at all. Kept as a valid value so a future gate could log safe calls for audit without changing the enum.
- **write** — reversible mutation (Write/Edit/most Bash/git commit-without-push/local-only migrations). Approve → gate returns allow → tool proceeds.
- **destructive** — irreversible or prod-scale (drop/delete/truncate/force-push/deploy). Approving one of these ADDITIONALLY requires the founder PIN (verified against [[workspaces]].`god_mode_pin_hash` via `verifyPin` in [[../libraries/god-mode]] — constant-time, one-way, no plaintext compare).
- **plan** — NOT a single tool call. A `plan` row is a plain-language UNIT OF WORK the founder approves ONCE (`tool_name='Plan'`, `preview` = the decision + its steps). Raised by `scripts/god-mode-plan.ts open` via `openPlan`. On approval the session's [[god_mode_sessions]].`active_plan_id` points at it and the gate AUTO-ALLOWS the non-destructive mechanical calls that implement it — the founder stops rubber-stamping every keystroke. No PIN (only `destructive` needs one); destructive calls still gate individually even while a plan is open. See [[../libraries/god-mode-permission-gate]] § Plan-scoped approvals.

Classification is deterministic (a rail over `tool_name`+`tool_input`) — see [[../lifecycles/god-mode]] § permission gate for the exact rules.

## `status` lifecycle

- **pending** — the gate is polling; the box tool call is blocked. The cockpit shows this card at the top of the Approvals tab.
- **approved** — the founder let the tool call through (PIN verified if `risk='destructive'`). The gate returns allow; the tool proceeds. Terminal.
- **denied** — the founder blocked it. The gate returns deny (no error message); the box continues without the call. Terminal.
- **asked** — the founder wrote back a QUESTION (`question_text`). The gate returns deny-WITH-the-question-as-message so the box reads it, replies in the transcript, and re-requests approval as a new row. Terminal for THIS row (a new pending row lands on the re-request).

## Chokepoint

All WRITES go through [[../libraries/god-mode]] via `createAdminClient()`. Phase-1 exposes only the read primitives + `armSession`/`disarmSession`; Phase-2 lands `openApproval` + `decideApproval` (`approve`/`deny`/`ask`); the plan-scoped hotfix adds `openPlan` (a `risk='plan'` row) + `setActivePlan`/`getActivePlan` on the session. No raw `.from('god_mode_approvals').insert|update` outside the SDK.

## `tool_name='june_remedy'` — parked CS Director money remedies

Beyond the Claude-Code tool-gate vocabulary, one non-tool `tool_name` rides this table: **`june_remedy`** ([[../libraries/june-remedy-approval]] `JUNE_REMEDY_TOOL`). When June's remedy is a refund/credit over `workspaces.june_refund_approval_threshold_cents`, `raiseJuneRemedyApproval` opens a `risk='decision'`, `category='june_refund'` card whose `tool_input` carries the **parked remedy** (`{ ticket_id, remedy, reasoning, action_type, amount_cents, raised_at }`). On the founder's Approve/Deny, the box-worker ~60s sweep `executeApprovedJuneRemedies` fires (or stands down) the remedy and stamps `tool_input.executed_at` for idempotency — **no extra column, no re-fire**. This is the only card type whose decision triggers a downstream *deferred execution* rather than unblocking a live-polling tool call.

## RLS

Service-role only. Same rationale as [[god_mode_sessions]].

## Related

- [[../libraries/june-remedy-approval]] — the CS Director founder-approval gate that raises + sweeps `june_remedy` cards.
- [[god_mode_sessions]] — the parent session.
- [[workspaces]].`god_mode_pin_hash` — the extra check on destructive approvals.
- [[../lifecycles/god-mode]] — end-to-end trace including the gate + cockpit rendering.
- [[../specs/god-mode]] — the spec this table implements.
