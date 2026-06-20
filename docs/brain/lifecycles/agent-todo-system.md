# Lifecycle: Agent To-Do system

Replaces synchronous ticket-by-ticket handling with an async approval queue. Every hour the **box-hosted escalation triage** ([[../specs/box-escalation-triage]]) sweeps escalated tickets on **Max** with a **solver→skeptic→quorum** loop, proposes concrete customer fixes, and writes them as `pending` todos; Dylan + Zach (and the CX manager) review the queue on [[../dashboard/tickets__todos]]; approval triggers execution via the Inngest worker, rejection routes the ticket to manual handling. System-level changes (rules, code) no longer ride this table — they become proposed [[../tables/sonnet_prompts]] / committed specs.

**Business outcome:** Dylan's 2–3 hrs/day of escalation handling drops to ~30 min/day of approval clicks, while preserving Dylan-level judgment on every customer touch. **The system never executes a customer-facing action without explicit human approval**, and each proposal is now **adversarially double-checked** (skeptic) before it can become a todo at all.

> **What changed (box-escalation-triage, 2026-06-20):** the **Anthropic-cloud Claude Code Routine** (the old reasoning pass + system-level execution pass + PR-cleanup pass) is **RETIRED**. The generator is now the box-hosted hourly **solver→skeptic→quorum** sweep on Max. **Customer-facing execution (the Inngest `agent-todo-execute` worker) + the dashboard approval are UNCHANGED** (and the worker now also runs `ticket_analysis_rescore`). **System-level todos no longer exist** — rule changes are proposed `sonnet_prompts`, code/analyzer fixes are committed `docs/brain/specs/` files on [[../dashboard/roadmap]].

## Runtimes
- **Box escalation triage** (`triage-escalations`, hourly, on Max, has git + read-only DB tools + the brain/`src/`/web): the generator. The [[../inngest/triage-escalations]] cron (`30 * * * *`) enqueues one `kind='triage-escalations'` [[../tables/agent_jobs]] job per workspace; the worker (`runEscalationTriageJob`, concurrency-1 `MAX_TRIAGE=1` lane) runs the solver→skeptic loop as **2–4 separate `claude -p` Max sessions** per ticket and, on quorum, materializes via `src/lib/agent-todos/triage.ts`. The worker is the **only component with prod creds** — it materializes; the Max sessions only reason.
- **Inngest worker** (`agent-todo-execute`, event-triggered, Vercel): customer-facing immediate execution (`customer_reply`/`customer_action`/`ticket_close`) **+ `ticket_analysis_rescore`** on approval. See [[../inngest/agent-todo-routine]].
- ~~**Claude Code Routine**~~ — RETIRED, replaced by the box sweep.

## End-to-end trace

1. **Escalation.** The orchestrator escalates a ticket in [[../inngest/unified-ticket-handler]] (3 sites). Those sites set `escalated_to = NULL` and `assigned_to = NULL` — escalated past every rule, routine-owned (not a human). (`escalation_reason` + `escalated_at` still set.)
2. **Enqueue (hourly).** The [[../inngest/triage-escalations]] cron (`30 * * * *`) inserts one `kind='triage-escalations'` [[../tables/agent_jobs]] job per workspace that has a routine-owned escalated ticket (dedupes against an in-flight triage job). The cron does no reasoning.
3. **Sweep — solver→skeptic→quorum (box, Max).** The worker (`runEscalationTriageJob`, concurrency-1) claims the job and, via `selectEscalatedForTriage`, picks up to `TRIAGE_CAP` (default 5) escalated tickets with **no active `agent_todos` group**. Per ticket:
   - **Solver** (`escalation-triage` skill, SOLVER mode — a top-level `claude -p` on Max, web search on, full brain/`src`/DB): asks *why did this escape every rule?* and decides one branch + a fix:
     - **customer_fix** → 1 `customer_reply` + N `customer_action` (+ `ticket_close`).
     - **escalation_false_positive** (mis-escalated) → an **analyzer-fix spec** (targets `src/lib/ticket-analyzer.ts`).
     - **analysis_gap** → `ticket_analysis_rescore` (+ a proposed rule if the pattern repeats).
     - **system_gap** → a code-change **spec**.
     - **no_action** → `ticket_close`.
   - **Skeptic** (a **separate, fresh** `claude -p` session, `escalation-triage` skill, SKEPTIC mode): adversarially re-checks the proposal against the brain, the rules, and DB → `agree | revise | reject`. `revise` → one bounded re-loop (solver resumes with the critique, skeptic re-checks fresh).
   - **Quorum.** **agree →** materialize (below). **reject / revise-still-disagree / unparseable →** materialize **nothing**, ticket stays escalated, disagreement logged. After **3 no-quorum runs** a ticket is deferred for a human.
   - Every ticket per sweep writes a [[../tables/triage_runs]] row (decision, verdict, materialized, both transcripts, the `group_id`).
4. **Materialize on quorum** (worker — the only component with prod creds, via `src/lib/agent-todos/triage.ts` `materializeTriageOutcome`):
   - **customer fix → `pending` `agent_todos`** (`customer_reply` / `customer_action` / `ticket_close` / `ticket_analysis_rescore`, one `group_id`, `source_ticket_id`, `pre_exec_context` + the two plain-English context blocks). Unchanged artifact + execution.
   - **rule change → `proposed` `sonnet_prompts`** (`status='proposed'`, `enabled=false`, `derived_from_ticket_id`) — **admin/Zach** approves (not owner-only).
   - **code / analyzer fix → committed `docs/brain/specs/{slug}.md`** on main (owner=cs, `**Derived-from-ticket:**`), surfaced on [[../dashboard/roadmap]] to commission a build. **No `code_change` todo, no PR from the sweep.**
5. **Review.** Dylan/Zach/CX manager open [[../dashboard/tickets__todos]] (grouped list, role-scoped bubble) → [[../dashboard/tickets__todos__id]] (what happened / what we propose / per-todo previews / collapsed conversation).
6. **Approve.** `POST /api/todos/[id]/approve` fires `agent-todo/execute` for any **Inngest-executable** type (the three customer-facing types **+ `ticket_analysis_rescore`**, gated by `isInngestExecutable()`). The worker drift-checks, dispatches (`sendTicketReply` / `directActionHandlers` / close / re-score), records the result, and auto-closes the ticket when the last customer-facing todo in the group executes. **`customer_action` dispatch fallback:** the three **Improve-only** account-repair types (`reassign_ticket_customer` · `send_magic_link` · `link_customer_accounts`) have no `directActionHandlers` entry (the Sonnet orchestrator must never trigger them), so `executeCustomerAction` routes them through `runImproveOnlyAccountAction` ([[../libraries/improve-actions]]) — the same dispatcher the Improve tab uses. This lets the escalation-triage solver propose the auto-detected duplicate-account fix as `customer_action` todos. `link_customer_accounts` self-enforces the empty-shell heuristic on this path too (+ system note "Resolved via To-Do system. Approved by {role}…"). A rescore-only group does **not** auto-close.
7. **Reject.** `POST /api/todos/[id]/reject` marks the todo (optional reason). The ticket is **not** auto-closed. When the whole group is rejected, the ticket's `escalated_to` is set to the **workspace owner** and tagged `todo:rejected`; it appears under "Rejected → me" in [[../dashboard/tickets__escalated]].
8. **Drift.** If the customer replies between approval and execution, the worker marks the todo `superseded` and the next sweep re-proposes against the fresh state.

## Code map
- Tables: [[../tables/agent_todos]] (`20260604190000_agent_todos.sql` + `20260620160100_agent_todos_prune_action_types.sql`) · [[../tables/triage_runs]] (`20260620160000_triage_runs.sql`).
- Shared lib: `src/lib/agent-todos/` — `constants.ts` (4-type taxonomy + `canApprove` + `isInngestExecutable`), `types.ts`, `execute.ts` (customer-facing + rescore + drift + auto-close), `triage.ts` (`selectEscalatedForTriage` + `materializeTriageOutcome`). **Deleted:** `reasoning.ts`, `system-execute.ts`.
- Generator: `src/lib/inngest/triage-escalations.ts` (hourly cron, registered in `src/app/api/inngest/route.ts`) → `scripts/builder-worker.ts` `runEscalationTriageJob` (the box sweep, runs the `escalation-triage` skill on Max).
- Inngest worker: `src/lib/inngest/agent-todo-execute.ts` (registered in `src/app/api/inngest/route.ts`).
- API: `src/app/api/todos/route.ts` (list), `…/[id]/route.ts` (detail), `…/[id]/approve` (fires `agent-todo/execute` via `isInngestExecutable()`), `…/[id]/reject`, `src/app/api/escalated/route.ts`, `src/app/api/branches/route.ts`.
- Dashboard: `src/app/dashboard/tickets/todos/{page,[id]/page}.tsx`, `…/tickets/escalated/page.tsx`, `…/branches/page.tsx`; sidebar links + bubbles in `src/app/dashboard/sidebar.tsx`.
- **Deleted scripts:** `scripts/agent-todo-routine-run.ts`, `scripts/agent-todo-backfill.ts` (and `scripts/print-routine-env.ts` is obsolete — the box keeps its own creds).

## Safety invariants
- No action executes without `status='approved'` + matching `approved_by`/`approval_role`. Role gate: `canApprove()`. (Supervisable autonomy: the box optimizes a **bounded proxy — double-checked proposals**; the skeptic is the internal check, human approval the external gate. [[../operational-rules]] § North star.)
- **Quorum before materialization.** Solver + skeptic must `agree`; no quorum → nothing materialized, ticket stays escalated, disagreement logged (in [[../tables/triage_runs]]). Hitting the rail = escalate, not execute.
- Drift check immediately before customer-facing execution; expired approvals supersede silently.
- One active group per ticket (`selectEscalatedForTriage` skips tickets with a pending/approved/executed group).
- The reasoning Max sessions have **no prod write access** — only the box worker materializes, and the box opens **no PR** (specs commit straight to main via the Contents API, like the planner).
- No silent retries — a `failed` todo stays failed and surfaces in the queue.
- The sweep is stateless between runs; state lives in `agent_todos` + `triage_runs`.

## Status / open work — ✅ box-hosted (2026-06-20)

The generator is now the **box-hosted hourly solver→skeptic→quorum sweep on Max** ([[../specs/box-escalation-triage]]). The **Anthropic-cloud Claude Code Routine is retired** (reasoning + system-execute + PR-cleanup passes deleted). Customer-facing execution (Inngest `agent-todo-execute`) + the dashboard approval are unchanged and live; the worker now also runs `ticket_analysis_rescore` on approval.

**Shipped (box-escalation-triage):**
- `triage-escalations-cron` ([[../inngest/triage-escalations]], `30 * * * *`, concurrency-1) → one `agent_jobs` `kind='triage-escalations'` job per workspace; `runEscalationTriageJob` (concurrency-1 `MAX_TRIAGE=1` lane) sweeps up to `TRIAGE_CAP`=5 tickets.
- Solver→skeptic→quorum as 2–4 separate `claude -p` Max sessions (`escalation-triage` skill, SOLVER/SKEPTIC modes); one bounded `revise` re-loop; 3-no-quorum human defer.
- Materialization in `src/lib/agent-todos/triage.ts`: customer fix → `pending` `agent_todos`; rule → `proposed` `sonnet_prompts` (admin/Zach); code/analyzer fix → committed `docs/brain/specs/` (owner=cs, Roadmap).
- New [[../tables/triage_runs]] audit table (one row per ticket per sweep, both transcripts).
- `agent_todos.action_type` pruned to the 4 kept types (TS union + NOT-VALID DB CHECK so historical rows survive); `ticket_analysis_rescore` moved to the Inngest worker (`isInngestExecutable()`).
- **Retired/deleted:** `scripts/agent-todo-routine-run.ts`, `scripts/agent-todo-backfill.ts`, `src/lib/agent-todos/reasoning.ts`, `src/lib/agent-todos/system-execute.ts`; the Anthropic-cloud routine concept.

**Carried forward (still live):** the human-gated approval queue + the customer-facing Inngest executor + `maybeAutoCloseGroup()` (close → unescalate → unassign) + the escalated observability rebuild + the branches surface. Archive-while-escalated guards still hold.

**Earlier hardening (2026-06-05/08), now historical** (the cloud-routine network-allowlist preflight, GitHub-REST-vs-`gh`, the direct-Messages-API tool loop, `git apply --recount`) applied to the deleted routine — kept on [[../inngest/agent-todo-routine]] as historical reference.

## Related
[[../specs/box-escalation-triage]] · [[../tables/agent_todos]] · [[../tables/triage_runs]] · [[../inngest/triage-escalations]] · [[../inngest/agent-todo-routine]] · [[../inngest/unified-ticket-handler]] · [[../libraries/action-executor]] · [[../functions/cs]] · [[../recipes/build-box-setup]] · [[../dashboard/tickets__todos]] · [[../dashboard/tickets__todos__id]] · [[../dashboard/tickets__escalated]] · [[../dashboard/branches]] · [[ticket-lifecycle]] · [[ai-analysis]] · [[ai-learning]] · [[../customer-voice]] · [[../operational-rules]]
