# ticket_directions

The **durable first-touch artifact** Sol writes **once per ticket** on the first-touch box session — an explicit `intent` + `context_summary` + `chosen_path` + `plan` + `guardrails` — so downstream cheap-execution turns run against a locked-in Direction instead of re-doing full-context reasoning every turn. One live row per ticket (partial UNIQUE on `ticket_id WHERE superseded_at IS NULL`). A rare inflection supersedes the live row (sets `superseded_at`) and inserts a fresh live row — the exact inversion of the cost curve the parent goal targets. See [[../specs/sol-ticket-direction-artifact-and-first-touch-box-session]] and [[../goals/sol-ticket-direction-then-cheap-execution]] § M1.

Written by Sol's box session (`runTicketHandleJob` — Phase 2) via `src/lib/ticket-directions.ts` (`writeDirection` / `superseDirection` / `getLiveDirection` — Phase 2 lands the SDK); until Phase 2 lands, the table exists but is unwritten.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `ticket_id` | `uuid` | — | → [[tickets]].id · ON DELETE CASCADE — the ticket the Direction is authored for |
| `intent` | `text` | — | one-line customer intent Sol distilled (e.g. "requesting a refund on the October order because the strap frayed") |
| `context_summary` | `text` | — | short prose summary of the merged customer + subscription + order context Sol read at first touch |
| `chosen_path` | `public.ticket_direction_path` | — | enum ∈ `playbook` \| `stateless` \| `needs_info` — `playbook` drives an existing playbook, `stateless` is a single stateless reply, `needs_info` asks the customer for a specific missing piece before any action |
| `plan` | `jsonb` | — | default `'{}'` — the shape of the plan (e.g. `{"playbook_slug":"refund-with-recovery"}`, `{"action":"send_stateless_reply"}`, `{"needs":["order_number"]}`) — Phase 2's SDK defines the shape per `chosen_path` |
| `guardrails` | `jsonb` | — | default `'{}'` — bounded proxy constraints downstream execution must respect (e.g. `{"max_coupon_pct":15,"never_promise":["expedited_shipping"]}`); a rail-hit = escalate, not execute (per CLAUDE.md § North star) |
| `authored_by` | `text` | — | default `'sol_box_session'` — surfaced for the rare non-Sol author (a founder-authored override) |
| `authored_at` | `timestamptz` | — | default `now()` — stamped at insert |
| `superseded_at` | `timestamptz` | ✓ | NULL = live row; non-NULL = a later inflection superseded this Direction. Compare-and-set from `superseDirection` (Phase 2) |

**Indexes:**
- `(workspace_id, ticket_id, authored_at DESC)` — the per-ticket "latest Direction" read (spec Phase 1 verification).
- **partial UNIQUE** `(ticket_id) WHERE superseded_at IS NULL` — the **one-live-row invariant**: two concurrent inserts of a live row for the same ticket race and exactly one succeeds (spec Phase 1 verification).

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `ticket_id` → [[tickets]].id.

**In:** none — downstream execution reads the live row through the SDK (Phase 2) but does not FK against it (a Direction is an authoring artifact, not a spine).

## Read paths

Phase 2 lands the read paths. On the first turn after the Sol session ships, [[../inngest/unified-ticket-handler]]'s cheap-execution branch will call `getLiveDirection(admin, ticket_id)` and drive off `chosen_path` + `plan` + `guardrails` instead of re-running the full-context orchestrator prompt.

## Row lifecycle

1. **Insert (`authored_at`, `superseded_at IS NULL`)** — Sol's box session (Phase 2's `runTicketHandleJob`) writes ONE row via `writeDirection` at the end of the session, after reading the ticket + merged customer + subscription context. The partial UNIQUE on `ticket_id WHERE superseded_at IS NULL` guarantees there is at most one live Direction per ticket at any moment.
2. **Supersede (`superseded_at` compare-and-set on NULL)** — a later inflection (customer pivots the ask, downstream execution hits a guardrail and escalates back to Sol) calls `superseDirection(admin, ticket_id)` which stamps `superseded_at = now()` on the live row via a compare-and-set on `superseded_at IS NULL`; a fresh `writeDirection` immediately follows with the new live row.

## RLS
Service-role only (RLS enabled with no policies). Every write goes through `createAdminClient()` from the Phase-2 SDK — per CLAUDE.md's "All writes go through `createAdminClient()`" invariant. No client-side reads.

## Invariants
- **One live row per ticket.** Enforced by the partial UNIQUE `(ticket_id) WHERE superseded_at IS NULL` — a concurrent double-dispatch of Sol against the same ticket errors on the loser instead of silently forking two Directions.
- **A Direction is authored, never mutated.** After `authored_at`, only `superseded_at` ever changes (compare-and-set on NULL). Correcting a Direction is `superseDirection` + `writeDirection` — never an in-place `UPDATE` of `intent` / `plan` / `guardrails`.
- **Guardrails bound the proxy, they do NOT drive it.** Downstream execution respects `guardrails` as hard rails (hit = escalate); it never treats them as targets to optimize. Same north-star principle as the top-level CEO → role-agent → tool leash (CLAUDE.md § North star).

## Migration

`supabase/migrations/20260925120000_ticket_directions.sql` (apply: `npx tsx scripts/apply-ticket-directions-migration.ts`). Idempotent — creates the `ticket_direction_path` enum (DO-guarded), the table, both indexes (`(workspace_id, ticket_id, authored_at DESC)` + the partial UNIQUE on `ticket_id WHERE superseded_at IS NULL`), and enables RLS with no policies.

---

[[../README]] · [[tickets]] · [[ticket_resolution_events]] · [[workspaces]] · [[../lifecycles/ticket-lifecycle]] · [[../specs/sol-ticket-direction-artifact-and-first-touch-box-session]] · [[../goals/sol-ticket-direction-then-cheap-execution]] · [[../functions/cs]] · [[../../CLAUDE]]
