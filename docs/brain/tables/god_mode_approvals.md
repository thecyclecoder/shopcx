# god_mode_approvals

The approvals queue+history for a [[god_mode_sessions]] session. One row per BLOCKED tool call the Phase-2 permission gate had to route to the founder — a `Write`/`Edit`, a non-allowlisted `Bash`, a migration apply, a `git push`, a destructive DDL. See [[../specs/god-mode]] · [[../lifecycles/god-mode]] · [[../functions/ceo]].

**North-star (supervisable autonomy):** every mutation the box makes under god-mode is COUNTER-SIGNED by the founder. The gate never auto-allows a write; it either finds the call on the safe-read allowlist and skips the table entirely, or lands a row here and blocks until the founder decides.

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
| `risk` | `text` | — | default `'write'` · CHECK ∈ `safe` \| `write` \| `destructive`. Deterministic classification of the blocked call (see below). |
| `status` | `text` | — | default `'pending'` · CHECK ∈ `pending` \| `approved` \| `denied` \| `asked`. Decision lifecycle (see below). |
| `question_text` | `text` | ✓ | Populated only on `status='asked'` — the founder's question back to the box. |
| `decided_at` | `timestamptz` | ✓ | Stamped when status leaves `pending`. |
| `created_at` | `timestamptz` | — | default `now()` |

**Indexes:**
- `god_mode_approvals_gate_poll_idx` — `(id, status)`. Hot path — the Phase-2 gate's poll loop.
- `god_mode_approvals_session_created_idx` — `(session_id, created_at desc)`. Cockpit render (pending at top, history below).
- `god_mode_approvals_workspace_created_idx` — `(workspace_id, created_at desc)`. Workspace-wide audit.

## `risk` classification

- **safe** — reserved. In practice safe reads (Read/Grep/Glob/WebSearch + allowlisted read-only Bash prefixes) AUTO-ALLOW without hitting this table at all. Kept as a valid value so a future gate could log safe calls for audit without changing the enum.
- **write** — reversible mutation (Write/Edit/most Bash/git commit-without-push/local-only migrations). Approve → gate returns allow → tool proceeds.
- **destructive** — irreversible or prod-scale (drop/delete/truncate/force-push/deploy). Approving one of these ADDITIONALLY requires the founder PIN (verified against [[workspaces]].`god_mode_pin_hash` via `verifyPin` in [[../libraries/god-mode]] — constant-time, one-way, no plaintext compare).

Classification is deterministic (a rail over `tool_name`+`tool_input`) — see [[../lifecycles/god-mode]] § permission gate for the exact rules.

## `status` lifecycle

- **pending** — the gate is polling; the box tool call is blocked. The cockpit shows this card at the top of the Approvals tab.
- **approved** — the founder let the tool call through (PIN verified if `risk='destructive'`). The gate returns allow; the tool proceeds. Terminal.
- **denied** — the founder blocked it. The gate returns deny (no error message); the box continues without the call. Terminal.
- **asked** — the founder wrote back a QUESTION (`question_text`). The gate returns deny-WITH-the-question-as-message so the box reads it, replies in the transcript, and re-requests approval as a new row. Terminal for THIS row (a new pending row lands on the re-request).

## Chokepoint

All WRITES go through [[../libraries/god-mode]] via `createAdminClient()`. Phase-1 exposes only the read primitives + `armSession`/`disarmSession`; Phase-2 lands `openApproval` + `decideApproval` (`approve`/`deny`/`ask`). No raw `.from('god_mode_approvals').insert|update` outside the SDK.

## RLS

Service-role only. Same rationale as [[god_mode_sessions]].

## Related

- [[god_mode_sessions]] — the parent session.
- [[workspaces]].`god_mode_pin_hash` — the extra check on destructive approvals.
- [[../lifecycles/god-mode]] — end-to-end trace including the gate + cockpit rendering.
- [[../specs/god-mode]] — the spec this table implements.
