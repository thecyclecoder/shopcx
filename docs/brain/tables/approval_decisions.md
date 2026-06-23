# approval_decisions

The **supervisable-autonomy ledger** — one row per **routed approval decision** ([[../specs/approval-routing-engine]] Phase 3). The North star ([[../operational-rules]] § supervisable autonomy): an autonomous tool answers to an objective-owner, never a silent proxy. When a future **live+autonomous** director auto-approves one of its tools' requests, the CEO must always be able to audit **what** the proxy decided and **why** — in **history**, never in the queue. This table is that ledger.

A decision is made either by the **CEO seat** (`decided_by='ceo'` — the request routed to the fail-safe root and the owner decided it), by a **human override** of a director's queue (`decided_by='human'`), or **autonomously** by a live+autonomous director (`decided_by='director'`, `autonomous=true` — the only path that sets `autonomous`). **Invariant:** no auto-approval without a row here capturing the reasoning. The flag enables *who decides*, never *whether it's recorded*.

**Workspace-scoped** (mirrors [[dashboard_notifications]] / [[director_messages]] — the decision belongs to the workspace whose [[agent_jobs]] raised it). RLS: any authenticated user reads (the history API + [[../dashboard/agents|Agents hub]] are owner-gated above the DB); service role does all writes.

**Primary key:** `id` (uuid)

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `agent_job_id` | `uuid?` | FK → `agent_jobs(id)` on delete **set null** · the job this decision gated |
| `pending_action_id` | `text?` | the string id of the decided action within `agent_jobs.pending_actions` (**not** a uuid) |
| `raised_by_function` | `text` | the org-chart function that owns the raising tool (`resolveApprover`'s input; `'ceo'` when unmapped) · default `'ceo'` |
| `routed_to_function` | `text` | where it routed: first live+autonomous ancestor, else `'ceo'` · default `'ceo'` |
| `decided_by` | `text` | `ceo｜director｜human` — who actually decided (check constraint) |
| `decision` | `text` | `approved｜declined｜escalated` (check constraint) · `escalated` = routed up rather than decided here |
| `reasoning` | `text?` | the human notes / the director's stated rationale — the auditable "why" |
| `autonomous` | `boolean` | true **only** for an autonomous director auto-approval · default `false` |
| `created_at` | `timestamptz` | default `now()` |

## Invariants

- **`autonomous ⇒ decided_by='director'`.** A `ceo`/`human` seat is never autonomous — [[../libraries/approval-decisions]] `recordApprovalDecision` forces `autonomous=false` unless a director decided (fail-safe).
- **Every autonomous decision is logged.** No auto-approval without a row here. The human approve/decline path ([[../libraries/roadmap-actions]] `approveRoadmapAction`) records best-effort (never breaks the decision); the autonomous path's recording is mandatory.
- **`reject` (reject-with-notes) is not a decision.** The optimizer-hero-preview-gate `reject` resumes the job for hero regeneration — it isn't a terminal approve/decline, so it is **not** logged here (the request re-surfaces).

## Readers / writers

- **`recordApprovalDecision(admin, input)`** ([[../libraries/approval-decisions]]) — inserts one row. Called from `approveRoadmapAction` on every terminal human approve/decline; a future autonomous director calls it with `decided_by='director', autonomous=true`.
- **`listApprovalDecisions(admin, workspaceId, role, filters)`** ([[../libraries/approval-decisions]]) — the history read. The **CEO sees every** decision in the workspace; a director sees only the decisions routed to it. Filters: function (CEO only) · decision · autonomous-vs-human.
- **`GET /api/developer/agents/decisions`** — owner-gated; backs the **Decision history** tab on the [[../dashboard/agents|Agents hub]].

## Migration

`supabase/migrations/20260703120000_approval_decisions.sql` (apply: `npx tsx scripts/apply-approval-decisions-migration.ts`). Idempotent — `create table if not exists` + `create index if not exists` + drop/create policy. Indexes: `(workspace_id, created_at desc)` and `(routed_to_function, created_at desc)`.

## Related

[[../specs/approval-routing-engine]] · [[../libraries/approval-decisions]] · [[../libraries/approval-router]] · [[function_autonomy]] · [[../dashboard/agents]] · [[../operational-rules]] (§ North star — supervisable autonomy)
