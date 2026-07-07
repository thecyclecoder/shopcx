# tickets

Customer support tickets. status (open/pending/closed/archived), channel, handled_by, ai_turn_count, journey/playbook state.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `channel` | `text` | — | default: `'email'` |
| `status` | `text` | — | default: `'open'` |
| `subject` | `text` | ✓ |  |
| `ai_confidence` | `float4` | ✓ |  |
| `ai_handled` | `bool` | — | default: `false` |
| `assigned_to` | `uuid` | ✓ |  |
| `first_response_at` | `timestamptz` | ✓ |  |
| `resolved_at` | `timestamptz` | ✓ |  |
| `csat_score` | `int4` | ✓ |  |
| `churn_risk_resolved` | `bool` | ✓ | default: `false` |
| `tags` | `text[]` | ✓ | default: `'{}'` |
| `email_message_id` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `received_at_email` | `text` | ✓ |  |
| `escalated_to` | `uuid` | ✓ |  |
| `escalated_at` | `timestamptz` | ✓ |  |
| `escalation_reason` | `text` | ✓ |  |
| `auto_reply_at` | `timestamptz` | ✓ |  |
| `pending_auto_reply` | `text` | ✓ |  |
| `last_customer_reply_at` | `timestamptz` | ✓ |  |
| `ai_draft` | `text` | ✓ |  |
| `ai_tier` | `text` | ✓ |  |
| `ai_source_type` | `text` | ✓ |  |
| `ai_source_id` | `uuid` | ✓ |  |
| `ai_workflow_id` | `uuid` | ✓ | → [[ai_workflows]].id |
| `ai_drafted_at` | `timestamptz` | ✓ |  |
| `ai_suggested_macro_id` | `uuid` | ✓ | → [[macros]].id |
| `ai_suggested_macro_name` | `text` | ✓ |  |
| `handled_by` | `text` | ✓ |  |
| `ai_turn_count` | `int4` | — | default: `0` |
| `ai_turn_limit` | `int4` | — | default: `4` |
| `last_ai_turn_at` | `timestamptz` | ✓ |  |
| `topic_drift_detected` | `bool` | — | default: `false` |
| `agent_intervened` | `bool` | — | default: `false` |
| `snoozed_until` | `timestamptz` | ✓ |  |
| `gorgias_id` | `int4` | ✓ |  |
| `meta_sender_id` | `text` | ✓ |  |
| `meta_comment_id` | `text` | ✓ |  |
| `meta_post_id` | `text` | ✓ |  |
| `profile_link_completed` | `bool` | — | default: `false` |
| `journey_id` | `uuid` | ✓ | → [[journey_definitions]].id |
| `journey_step` | `int4` | ✓ | default: `0` |
| `journey_data` | `jsonb` | ✓ | default: `'{}'` |
| `journey_nudge_count` | `int4` | — | default: `0` |
| `archived_at` | `timestamptz` | ✓ |  |
| `closed_at` | `timestamptz` | ✓ |  |
| `ai_clarification_turns` | `int4` | — | default: `0` |
| `needs_clarification` | `bool` | — | default: `false` |
| `ai_clarification_turn` | `int4` | — | default: `0` |
| `ai_detected_intent` | `text` | ✓ |  |
| `ai_intent_confidence` | `int4` | ✓ |  |
| `journey_history` | `jsonb` | — | default: `'[]'` |
| `active_playbook_id` | `uuid` | ✓ | → [[playbooks]].id |
| `playbook_step` | `int4` | — | default: `0` |
| `playbook_queue` | `jsonb` | — | default: `'[]'` |
| `playbook_context` | `jsonb` | — | default: `'{}'` |
| `playbook_exceptions_used` | `int4` | — | default: `0` |
| `merged_into` | `uuid` | ✓ | → [[tickets]].id |
| `page_context` | `jsonb` | ✓ |  |
| `last_analyzed_at` | `timestamptz` | ✓ |  |
| `detected_language` | `text` | ✓ |  |
| `do_not_reply` | `bool` | — | default: `false` |
| `do_not_reply_at` | `timestamptz` | ✓ |  |
| `ai_disabled` | `bool` | — | default: `false` |
| `ai_disabled_by` | `uuid` | ✓ | → `auth.users`.id |
| `ai_disabled_at` | `timestamptz` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `active_playbook_id` → [[playbooks]].`id`
- `ai_suggested_macro_id` → [[macros]].`id`
- `ai_workflow_id` → [[ai_workflows]].`id`
- `customer_id` → [[customers]].`id`
- `journey_id` → [[journey_definitions]].`id`
- `merged_into` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ai_token_usage]].`ticket_id`
- [[appstle_api_calls]].`ticket_id`
- [[chargeback_events]].`ticket_id`
- [[email_events]].`ticket_id`
- [[escalation_gaps]].`ticket_id`
- [[grader_prompts]].`derived_from_ticket_id`
- [[journey_sessions]].`ticket_id`
- [[macro_usage_log]].`ticket_id`
- [[pattern_feedback]].`ticket_id`
- [[replacements]].`ticket_id`
- [[returns]].`ticket_id`
- [[sonnet_prompts]].`derived_from_ticket_id`
- [[store_credit_log]].`ticket_id`
- [[ticket_analyses]].`ticket_id`
- [[ticket_heal_attempts]].`ticket_id`
- [[ticket_messages]].`ticket_id`
- [[ticket_research_runs]].`ticket_id`
- [[tickets]].`merged_into`
- [[widget_sessions]].`ticket_id`

## Common queries

### Open tickets in a channel
```ts
const { data } = await admin.from("tickets")
  .select("id, subject, customer_id, created_at")
  .eq("workspace_id", workspaceId)
  .eq("status", "open")
  .eq("channel", "email")
  .is("merged_into", null);
```

### Find tickets handled by AI / journey / workflow
```ts
const { data } = await admin.from("tickets")
  .select("id, handled_by")
  .eq("workspace_id", workspaceId)
  .or("handled_by.eq.AI Agent,handled_by.like.Journey:%,handled_by.like.Workflow:%");
```

### Customer's full ticket history (linked accounts)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("tickets")
  .select("id, subject, status, channel, created_at")
  .in("customer_id", ids)
  .is("merged_into", null)
  .order("created_at", { ascending: false });
```

### Tickets escalated to a specific agent
```ts
const { data } = await admin.from("tickets")
  .select("id, subject, escalation_reason, escalated_at")
  .eq("workspace_id", workspaceId)
  .eq("escalated_to", agentUserId)
  .eq("status", "open");
```

### Active playbook tickets needing manual review
```ts
const { data } = await admin.from("tickets")
  .select("id, active_playbook_id, playbook_step, playbook_exceptions_used")
  .eq("workspace_id", workspaceId)
  .not("active_playbook_id", "is", null);
```

## Gotchas

- `status`: `"open"`, `"closed"`, `"archived"` (lowercase). **`pending` is NOT used in production data** — older docs claim it but no rows have it. Use `open` for "AI is awaiting customer reply"; `closed` for "resolved"; `archived` for "auto-archived after retention threshold."
- `channel`: `"email"`, `"chat"`, `"help_center"`, `"social_comments"`, `"meta_dm"`, `"sms"`, `"portal"`. `portal` = created via the customer-portal "Support" sidebar ([[../libraries/portal__handlers__support]]); behaves like `chat` for AI (short replies, HTML, personality, response delay) but **always delivers by email** with a threaded digest — see [[../libraries/portal__thread-email]]. (`help_center` is the older public help-center widget/form.)
- `handled_by` is a free-text label — `"AI Agent"`, `"Workflow: order_tracking"`, `"Journey: cancel"`, or a display_name. Filter for the customer-reply-driven AI path with `LIKE 'Journey:%' OR ='AI Agent' OR LIKE 'Workflow:%'`.
- `escalated_to` set when escalated to a human; `assigned_to` is the human owner.
- `escalated_at` / `escalated_to` / `escalation_reason` are an **open-state** concept and are **cleared to `null` whenever the ticket transitions to `closed`/`resolved`/`archived`** — at every status-write path (`maybeAutoCloseGroup`, the manual close/bulk actions, workflow/journey closes, portal closes, spam/fraud closes). Resolving ends escalation; **reopening does NOT auto-re-escalate** (a fresh escalation is a new decision). So a terminal-status ticket should never carry escalation flags, and the Escalated view ([[../dashboard/tickets__escalated]]) additionally filters them out. See [[../specs/clear-escalation-on-resolve]].
- **The Escalated dashboard read path (`GET /api/escalated`) is backed by a partial btree `idx_tickets_escalated (workspace_id, escalated_at DESC) WHERE escalated_at IS NOT NULL`** (migration `20260817120000`, applied to prod with `CREATE INDEX CONCURRENTLY`). Without it Postgres seq-scanned tickets + sorted in memory and the route hit Vercel's 300s function timeout. Same pattern as `idx_tickets_snoozed` / `idx_tickets_handled_by`. If you add another `escalated_at`-ordered workspace-scoped query, this index serves it too — don't add a duplicate.
- `agent_intervened` flips true the moment a real human sends an outbound — AI must read this before generating.
- `merged_into` (self-FK): merged duplicates point at the surviving ticket. Filter with `merged_into IS NULL` to get canonical rows only.
- `do_not_reply` blocks outbound — e.g. mailer-daemon. Set by inbound filters.
- `ai_disabled` is an explicit **human directive** — a person clicks "Turn off AI on this ticket" in the dashboard. The [[../inngest/unified-ticket-handler]] hard-exits on inbound (mirrors the `do_not_reply` short-circuit) and [[../libraries/ticket-analyzer]] skips analysis + escalation. **Non-propagating on merge** — the surviving ticket keeps its own value (default `false`), because a merge conveys context, never control. Toggled via `PATCH /api/tickets/[id]` with `{ ai_disabled: true|false }`; the endpoint stamps `ai_disabled_by` + `ai_disabled_at` and writes an audit `ticket_messages` row. Phase 1 of `docs/brain/specs/human-directives-hard-gates-over-ticket-ai.md`.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
