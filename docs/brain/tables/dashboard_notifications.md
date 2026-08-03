# dashboard_notifications

Generic notification system — macro_suggestion, pattern_review, knowledge_gap, fraud_alert, manual_action_needed, etc. Surfaced in the bell.

Also the backing store for the **Agents-hub inbox** ([[../dashboard/agents]]) — the reserved `agent_*` types (`agent_message`, `agent_approval_request`, `agent_daily_summary`) are bucketed into the three inbox tabs (the generic bell ignores them; the inbox ignores everything else). The approval-routing engine ([[../libraries/approval-inbox]], M2) emits an `agent_approval_request` per [[agent_jobs]] `needs_approval`, carrying its routing + decision affordances in `metadata` (see Gotchas).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `user_id` | `uuid` | ✓ |  |
| `type` | `text` | — | CHECK-constrained. Valid: `macro_suggestion`, `pattern_review`, `knowledge_gap`, `system`, `fraud_alert`, `chargeback_alert`, `duplicate_order_alert`, `escalation_gap`, `agent_approval_request`, `agent_message`, `agent_daily_summary`, `return_request`, `mario_accuracy_alarm`, `refund_drift`, `fulfillment_alert`. **Inserting an unlisted type → PostgREST 400 (23514)**; most inserts are fire-and-forget, so a bad type silently drops the notification. |
| `title` | `text` | — |  |
| `body` | `text` | ✓ | The message text column. **It is `body`, not `message`** — inserting `message:` → PostgREST 400 (PGRST204, unknown column) → the fire-and-forget notification is silently lost. |
| `link` | `text` | ✓ |  |
| `metadata` | `jsonb` | ✓ | default: `'{}'` |
| `read` | `bool` | — | default: `false` |
| `dismissed` | `bool` | — | default: `false` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("dashboard_notifications")
  .select("id, title, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("dashboard_notifications")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- **One open card per `dedupe_key` — DB-enforced ([[../specs/one-open-escalation-per-thing-and-a-founder-answer-stops-the-asking]] Phase 1).** A UNIQUE partial index (`dashboard_notifications_dedupe_key_open_uniq`) on `((metadata->>'dedupe_key'))` `WHERE dismissed = false and metadata ? 'dedupe_key'` makes the dedupe authoritative at the DB level. Concurrent mints for the same open key REJECT at `23505 unique_violation` — the emitter interprets that as "another sweep won the race" and TOUCHES the winning card instead of creating a duplicate. The 2026-07-28 320,734-card storm (864 in one minute) was possible because nothing enforced the key; the read-then-write dedupe raced. `metadata.escalation_seen_count` + `escalation_first_seen_at` + `escalation_last_seen_at` on the OPEN card carry the persistent-vs-transient signal the duplicates used to convey with volume. A dismissed card DOES let a fresh mint through (the resolved-then-re-emerged case is a legitimate new signal). The emitter's per-key hourly ceiling (`ESCALATION_MINT_CEILING_PER_HOUR`) is the safety valve: past it, one `escalation_kind='escalation_loop_detected'` card fires instead of continuing to bump the original.
- **`agent_approval_request` metadata (M2).** The routed Approval Request carries its routing + decision affordances in `metadata`: `agent_job_id` (the gated [[agent_jobs]] row — the reconciler's idempotency key), `routed_to_function` (the resolved approver slug the inbox API filters each role on; legacy/unrouted ⇒ the CEO), `raised_by_function`, `approve_action_id` (the single pending action inline Approve/Decline acts on, or null for multi-choice → use `deep_link`), `deep_link`, `kind`, `spec_slug`. Emitted + auto-dismissed by [[../libraries/approval-inbox]] `reconcileApprovalInbox` (it sets `dismissed=true` the moment the job leaves `needs_approval`) — don't hand-edit these rows.
- **`slack_message_ts` + `slack_chat_mode` + `coach_thread_id` ([[../lifecycles/ada-slack-routed-approvals]]).** A CEO-routed Approval Request whose workspace has `slack_ada_channel_id` set is mirrored into `#cto-ada` as Ada and its posted `ts` stashed back on `metadata.slack_message_ts` (Phase 1) — the idempotency key for the reconciler's dismiss thread reply (Phase 2) and the web→Slack mirror in `approveRoadmapAction` (Phase 4 — `chat.update` the card or post a closing thread reply). `slack_chat_mode=true` means the Slack surface is a chat-style invitation thread, not a Block Kit card (Phase 3 — multi-choice / brain-touching / wall-of-diff approvals); `coach_thread_id` is the matching [[director_coach_threads]] row a founder reply resumes. A non-CEO routed approval, or a workspace without `slack_ada_channel_id`, carries none of these keys — the reconciler short-circuits.
- Probe before assuming — see [[../README]] § Probing technique.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
