# agent_coaching_log

The director→worker **communication log** — one row per coaching act ([[../specs/worker-coaching-loop]], Phase 1). A real, visible message ("🛠️ Ada coached 🔴 Remi: stop dismissing recurring breaks as foreign — they're real") carrying the **old→new instruction diff**, the **triggering pattern**, the **director_activity rows** that prompted it, the **attempt count**, the **post-coaching re-check** verdict, and the **#directors board post** it produced.

Surfaced on the worker's **profile page** (`/dashboard/agents/[role]` → "Coaching history") and (as a board `update`) on the [[../libraries/director-board|#directors board]]. Written via [[../libraries/agent-instructions]] `coachAgent`; orchestrated by [[../libraries/agent-coaching]] `runAgentCoachingPass`.

A row's `kind` records what the director did: **`coaching`** (amended the instruction set), **`code-bug-route`** (a real defect → routed to [[../specs/repair-agent|Repair]], not coached), or **`escalation`** (coached ≥N times and it still recurs → escalated to the CEO). The `recheck_status` closes the loop: did the class recur on the worker's next runs (`recurred`) or did the learning stick (`stuck`)?

**Workspace-scoped.** RLS: any authenticated user reads (the profile/history surface is owner-gated above the DB); service role does all writes.

**Migration:** `supabase/migrations/20260703120000_worker_coaching.sql` · apply via `npx tsx scripts/apply-worker-coaching-migration.ts`.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `agent_kind` | `text` | the worker the message was sent **to** ([[agent_jobs]] kind) |
| `coached_by` | `text` | the **supervising director's** function slug (the sender, e.g. `platform`) |
| `error_class` | `text` | the class of mistake addressed |
| `triggering_pattern` | `text` | the repeated mistake that prompted it · default `''` |
| `old_instruction` | `text` | the prior guidance (null on a first coaching for the class) — the diff `from` |
| `new_instruction` | `text` | the new guidance — the diff `to` · default `''` |
| `reasoning` | `text` | the "why" · default `''` |
| `instruction_id` | `uuid` | FK → [[agent_instructions]]`(id)` — the amendment this logged (null for a route/escalation) |
| `source_activity_ids` | `jsonb` | the [[director_activity]] row ids (the repeated mistakes) that prompted it · default `[]` |
| `attempt` | `int` | which coaching attempt for the `(worker, class)` — drives the **escalate-after-N** guard · default `1` |
| `kind` | `text` | `coaching｜code-bug-route｜escalation` — **open vocabulary** · default `coaching` |
| `recheck_status` | `text` | `pending｜stuck｜recurred` — the post-coaching re-check · default `pending` |
| `rechecked_at` | `timestamptz` | when the re-check ran (null while `pending`) |
| `board_message_id` | `uuid` | FK → [[director_messages]]`(id)` — the board post this produced |
| `created_at` | `timestamptz` | default `now()` |

## Indexes

- `worker_coaching_log_worker_idx` on `(workspace_id, agent_kind, created_at desc)` — the profile-page history read.
- `worker_coaching_log_class_idx` on `(agent_kind, error_class, created_at desc)` — attempt counting + re-check.

## Common queries

### A worker's coaching history (the profile page)
```ts
const { data } = await admin.from("agent_coaching_log")
  .select("*").eq("workspace_id", workspaceId).eq("agent_kind", "regression")
  .order("created_at", { ascending: false }).limit(50);
```

## Gotchas

- `attempt` is the escalation guard's counter — at `COACHING_ATTEMPTS_BEFORE_ESCALATE` the director escalates instead of re-coaching.
- A `code-bug-route` / `escalation` row has no `instruction_id` (no instruction was amended).

## Related

[[../libraries/agent-instructions]] · [[../libraries/agent-coaching]] · [[agent_instructions]] · [[director_activity]] · [[director_messages]] · [[../specs/worker-coaching-loop]] · [[../specs/repair-agent]] · [[../goals/devops-director]]
