# approval_decisions

The supervisable-autonomy **audit ledger**: one row per decision a director (or the CEO) makes on a routed Approval Request ([[../specs/approval-routing-engine]] M2 surface · [[../specs/platform-director-agent]] first writer · [[../goals/devops-director]]). The north-star contract made auditable — every **autonomous auto-approval** the [[../libraries/platform-director|Platform/DevOps Director]] makes writes a row here with its reasoning, so the CEO can read after the fact **what** the proxy decided and **why** (CEO → Director → tool). An **escalation** writes a row too (`decision='escalated'`) — the director punted the high-stakes call UP rather than acting.

Written via [[../libraries/approval-decisions]] `recordApprovalDecision` (best-effort, service-role only). The **first concrete writer** is the [[../specs/platform-director-agent|Platform/DevOps Director]]: for each Platform-routed approval it confirms sound + low-risk + within the leash, it auto-approves (the existing approve path flips the job `queued_resume`) and logs `decision='approved', decided_by='director', autonomous=true`; anything outside the leash or unconfirmable it escalates and logs `decision='escalated'`.

**Workspace-scoped** (mirrors [[director_activity]] / [[director_messages]]). RLS: any authenticated user reads (the CEO Decision-history surface is owner-gated above the DB); service role does all writes.

**Migration:** `supabase/migrations/20260703120000_approval_decisions.sql` · apply via `npx tsx scripts/apply-approval-decisions-migration.ts`.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `agent_job_id` | `uuid` | FK → `agent_jobs(id)` on delete set null — the gated job the decision acted on |
| `pending_action_id` | `text` | the specific pending action decided, when a job carries more than one (null = the whole job) |
| `raised_by_function` | `text` | the function that owns the raising tool (e.g. `platform`); `ceo` when the kind is unmapped · default `ceo` |
| `routed_to_function` | `text` | where the approval was routed — the deciding role's slug, or `ceo` (fail-safe root) · default `ceo` |
| `decided_by` | `text` | who decided — **open vocabulary, no CHECK**: `director` (autonomous) ｜ `ceo` ｜ `human` |
| `decision` | `text` | the call — **open vocabulary**: `approved` ｜ `declined` ｜ `escalated` (punted UP to the CEO) |
| `reasoning` | `text` | the plain-text "why" the CEO audits after the fact · default `''` |
| `autonomous` | `boolean` | the decision was made by a live+autonomous director with no human in the loop · default `false` |
| `metadata` | `jsonb` | structured per-decision context: `{ kind?, spec_slug?, leash?, ... }` · default `{}` |
| `created_at` | `timestamptz` | default `now()` |

## Indexes

- `approval_decisions_ws_created_idx` on `(workspace_id, created_at desc)` — the CEO Decision-history read.
- `approval_decisions_job_idx` on `(agent_job_id)` — every decision touching one gated job.
- `approval_decisions_routed_idx` on `(routed_to_function, created_at desc)` — per-deciding-role slice (e.g. everything the platform director auto-approved).

## Related

[[../libraries/approval-decisions]] · [[../libraries/platform-director]] · [[../specs/platform-director-agent]] · [[../specs/approval-routing-engine]] · [[../libraries/approval-router]] · [[../goals/devops-director]] · [[director_activity]] · [[agent_jobs]]
