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
| `chosen_path` | `public.ticket_direction_path` | — | enum ∈ `playbook` \| `journey` \| `workflow` \| `stateless` \| `needs_info` — `playbook` drives an existing playbook, `journey` launches a matched [[journey_definitions]] row (Phase 1 of [[../specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]]), `workflow` runs a matched [[workflows]] row identified by its `trigger_tag` (Phase 1 of [[../specs/ticket-direction-path-workflow-enum-drift]]), `stateless` is a single stateless reply, `needs_info` asks the customer for a specific missing piece before any action |
| `plan` | `jsonb` | — | default `'{}'` — the shape of the plan (e.g. `{"playbook_slug":"refund-with-recovery"}`, `{"journey_slug":"cancel_subscription"}`, `{"action":"send_stateless_reply"}`, `{"needs":["order_number"]}`) — the SDK defines the shape per `chosen_path` |
| `guardrails` | `jsonb` | — | default `'{}'` — bounded proxy constraints downstream execution must respect (e.g. `{"max_coupon_pct":15,"never_promise":["expedited_shipping"]}`); a rail-hit = escalate, not execute (per CLAUDE.md § North star) |
| `authored_by` | `text` | — | default `'sol_box_session'` — surfaced for the rare non-Sol author (a founder-authored override) |
| `authored_at` | `timestamptz` | — | default `now()` — stamped at insert |
| `superseded_at` | `timestamptz` | ✓ | NULL = live row; non-NULL = a later inflection superseded this Direction. Compare-and-set from `superseDirection` (Phase 2) |
| `resession_count` | `integer` | — | default `0` — per-ticket re-session counter. Incremented on every router-driven supersede + fresh Sol dispatch (Phase 2 of [[../specs/sol-runaway-re-session-cap-guardrail]]). Compared against [[ai_channel_config]].`sol_max_resessions` — when the count reaches the cap the router escalates the ticket to the routine lane instead of dispatching another Sol session. Zero on the first Direction; N after N re-sessions |

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
2. **Required-outcomes items authored alongside the Direction** — the message-is-last pipeline ([[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] Phase 1) distills the customer's concrete asks into N structured [[ticket_required_outcomes]] rows keyed to the same `ticket_id` (and optionally back-linked via `direction_id`). Downstream: Phase 2's [[../libraries/honor-required-outcomes|honor step]] executes + verifies each item; Phase 3's [[../libraries/sol-outcome-claim-guard|send guard]] blocks any reply asserting an outcome whose backing row isn't `status='verified'`; Phase 4's [[../libraries/outcome-completion-gate|completion gate]] blocks auto-close until every row is verified.
3. **Supersede (`superseded_at` compare-and-set on NULL)** — a later inflection (customer pivots the ask, downstream execution hits a guardrail and escalates back to Sol) calls `superseDirection(admin, ticket_id)` which stamps `superseded_at = now()` on the live row via a compare-and-set on `superseded_at IS NULL`; a fresh `writeDirection` immediately follows with the new live row.

### Agent-session visibility notes (agent-session-internal-notes)

**All three CS box agents — Sol (`runTicketHandleJob`), Cora (`runTicketAnalyzeJob`), June (`runCsDirectorCallJob`) — stamp an internal note at each session boundary** (`stampAgentSessionNote` → a `ticket_messages` row with `visibility='internal'`, `author_type='system'` — renders in the ticket's internal-note lane, never reaches the customer). The note is keyed to the session by the short job id (the same `[handle|analyze|cs-director:xxxxxxxx]` token in the worker logs). Best-effort — a note-insert failure never wedges the job (mirrors the `sol_handled_at` stamp).

**Sol** (start fires *before* the box session, so a hang / timeout / crash still leaves a trace):
- **Start** — `Sol is reviewing this ticket in session <id>.`
- **Complete** — `Sol's session <id> is complete — chosen path: <path>.`
- **Escalated to June** — `Sol's session <id> is complete — escalated to June (the CS final call). Reason: <reason>` (the `escalate_to_june` verdict, the policy-gate-not-run path, or a guard/honor block on the reply — see § escalate-to-June below).
- **Failed** — `Sol's session <id> failed: <detail>`.

**Cora** (QC grader — real grades only; skips stay silent to avoid flooding the lane):
- **Start** — `Cora (QC grader) is reviewing this ticket in session <id>.`
- **Complete** — `Cora's session <id> is complete — QC score <n>/10 (issues: …).`

**June** (CS Director — her detailed per-verdict note is the completion-side detail; these are the session-boundary markers):
- **Start** — `June (CS Director) is reviewing this escalated ticket in session <id>.`
- **Complete** — `June's session <id> is complete — decision: <decision>; ticket <closed + de-escalated | escalated to the founder … | remedy parked for founder approval …>.`

The gap this closes: a session that escalated (e.g. ticket `977b1510` — customer owed one more unit but fulfilling it would exceed the self-serve exchange cap, so Sol correctly escalated) previously left NO trace on the ticket — from the dashboard it looked like "the agent went in and nothing happened."

### Escalate to June — there is no "needs human" in CS (never-needs-human-escalate-to-june)

When Sol hits a rail she can't resolve within her leash — a judgment call, an approval over her authority, a rail she can't clear, a guard/honor block on her reply, or an edge case (even a legal team reaching out) — she escalates to **June**, the CS Director and the final CS call, via `escalateSolRailHit` ([[../libraries/portal__escalate-sol-rail-hit]]): `escalated_at = now`, `escalated_to = null`, so the [[../inngest/triage-escalations]] cron enqueues a `cs-director-call` (June's review). There is **no "human" fallback** — no human ever does mutations; the only human touch is the founder *approving* something June routes via Eve's SMS. June then either handles the ticket herself (her transition **unescalates + closes** it — [[../libraries/cs-director]] `decideCsDirectorTicketTransition`) or, when she needs the founder (a money call over the approval threshold, or a heads-up), escalates to the founder via the CEO inbox + Eve. Sol's verdict is `escalate_to_june` (legacy `needs_human` still accepted as an alias while boxes pull the new skill).

## RLS
Service-role only (RLS enabled with no policies). Every write goes through `createAdminClient()` from the Phase-2 SDK — per CLAUDE.md's "All writes go through `createAdminClient()`" invariant. No client-side reads.

## Invariants
- **One live row per ticket.** Enforced by the partial UNIQUE `(ticket_id) WHERE superseded_at IS NULL` — a concurrent double-dispatch of Sol against the same ticket errors on the loser instead of silently forking two Directions.
- **A Direction is authored, never mutated.** After `authored_at`, only `superseded_at` ever changes (compare-and-set on NULL). Correcting a Direction is `superseDirection` + `writeDirection` — never an in-place `UPDATE` of `intent` / `plan` / `guardrails`.
- **Guardrails bound the proxy, they do NOT drive it.** Downstream execution respects `guardrails` as hard rails (hit = escalate); it never treats them as targets to optimize. Same north-star principle as the top-level CEO → role-agent → tool leash (CLAUDE.md § North star).

## Migration

`supabase/migrations/20260925120000_ticket_directions.sql` (apply: `npx tsx scripts/apply-ticket-directions-migration.ts`). Idempotent — creates the `ticket_direction_path` enum (DO-guarded), the table, both indexes (`(workspace_id, ticket_id, authored_at DESC)` + the partial UNIQUE on `ticket_id WHERE superseded_at IS NULL`), and enables RLS with no policies.

`supabase/migrations/20260930120000_sol_resession_cap.sql` (apply: `npx tsx scripts/apply-sol-resession-cap-migration.ts`) — adds `resession_count integer NOT NULL DEFAULT 0` (Phase 1 of [[../specs/sol-runaway-re-session-cap-guardrail]]). Idempotent (ADD COLUMN IF NOT EXISTS).

`supabase/migrations/20261004120000_ticket_directions_journey_path.sql` (apply: `npx tsx scripts/apply-ticket-directions-journey-path-migration.ts`) — extends the `ticket_direction_path` enum with `'journey'` (Phase 1 of [[../specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]]) so Sol's Direction can name the specific matched journey slug on the Direction (`chosen_path='journey'` + `plan.journey_slug`). `writeDirection` in [[../libraries/ticket-directions]] gates the slug against `journey_definitions` (`is_active=true`, workspace-scoped) before the row lands; an unknown slug bails HERE with `journey_slug_unknown`, not at the Phase-2 `launchJourneyForTicket` step. Idempotent (ADD VALUE IF NOT EXISTS).

`supabase/migrations/20261213120000_ticket_direction_path_workflow.sql` — extends the `ticket_direction_path` enum with `'workflow'` (Phase 1 of [[../specs/ticket-direction-path-workflow-enum-drift]]) so Sol's Direction can name the specific matched workflow `trigger_tag` on the Direction (`chosen_path='workflow'` + `plan.workflow_tag`). Closes a drift where the TypeScript union at [[../libraries/ticket-directions]] `TicketDirectionPath` already listed `'workflow'` and `validatePlanForPath` had a full validation branch for it, but the DB enum was missing the value — every Sol session that picked the workflow path died on the insert (three measured kills between 2026-07-28 and 2026-08-05; Amy Schwartz's ticket is the ground-truth case). Applied unattended by [[../libraries/control-tower/migration-drift]] `applyMergedMigrations`. Idempotent (ADD VALUE IF NOT EXISTS).

---

[[../README]] · [[tickets]] · [[ticket_resolution_events]] · [[ticket_required_outcomes]] · [[workspaces]] · [[../lifecycles/ticket-lifecycle]] · [[../specs/sol-ticket-direction-artifact-and-first-touch-box-session]] · [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] · [[../goals/sol-ticket-direction-then-cheap-execution]] · [[../functions/cs]] · [[../../CLAUDE]]
