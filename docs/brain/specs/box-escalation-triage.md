# Box-hosted Escalation Triage (hourly solver→skeptic→quorum) ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform" (box-agent family with [[box-spec-chat]] + [[box-ticket-improve]]; replaces the Anthropic-cloud agent-todo routine in [[../lifecycles/agent-todo-system]]). CS ownership of ticket-derived code specs via [[../functions/cs]].

**Retire** the current Anthropic-cloud "agent-todo routine" (`scripts/agent-todo-routine-run.ts` + the API-based reasoning/system-execute passes) and **replace it with a box-hosted hourly Max routine** that sweeps **escalated tickets** with a **two-pass solver→skeptic→quorum** loop. An escalated ticket is escalated precisely because it **slipped past every deterministic + prompt rule + the orchestrator** ([[../lifecycles/ai-analysis]], `unified-ticket-handler.ts` sets `escalated_at=now(), escalated_to=NULL` → routine-owned). So the routine: (1) a **Solver** figures out the fix to **unescalate** it — or, if it was **escalated incorrectly**, proposes a **spec to fix the ticket analyzer**; (2) a **Skeptic** independently re-checks the situation against the brain, rules, and DB settings to confirm the issue is correctly understood and the solution is right; (3) on **quorum**, it materializes the same `agent_todos` the old routine produced. All on **Max via `claude -p`** (no `ANTHROPIC_API_KEY`, $0 marginal), with full brain/`src/`/web powers.

**Outcome:** every hour the box clears the escalation queue at higher quality than a single pass — each proposed resolution is adversarially double-checked before it becomes an actionable to-do, mis-escalations become analyzer-fix specs instead of bad customer replies, and nothing ships unless solver + skeptic agree (no quorum → stays escalated for a human). Same human-gated `agent_todos` output + execution as today; just smarter, self-checking, and on Max.

## North star (supervisable autonomy)
This routine optimizes a **bounded proxy — well-formed, double-checked *proposals*** — it does **not** silently mutate customers. Customer fixes land as **`pending` `agent_todos`** (human/role-approved before execution, exactly as today); rule changes land as **proposed `sonnet_prompts`**; code/analyzer changes land as **proposed spec files** on Roadmap. The **skeptic is the internal check; human approval is the external gate.** When solver + skeptic **can't reach quorum, the ticket stays escalated** (hitting the rail = escalate, not execute). CEO → CS role → this tool. See [[../operational-rules]] § North star.

## Trigger + sweep
- **Hourly Inngest cron** (the box has no internal ticker; cron-enqueue is the precedent, cf. `portal-auto-resume`) inserts one `agent_jobs` row `kind='triage-escalations'`, `status='queued'`. The box claims it (`claim_agent_job(['triage-escalations'])`, own concurrency-1 lane) and runs the sweep — a top-level `claude -p` on Max, web search on, in a repo checkout.
- **Queue selection** (reuse the current routine's filter): tickets with `escalated_at IS NOT NULL` AND `escalated_to IS NULL` (routine-owned, not human-assigned) AND **no active `agent_todos` group** (one active group per ticket — dedupe). Cap per run (e.g. N tickets/hour) to bound cost; log what was deferred (no silent truncation).

## Per-ticket loop (solver → skeptic → quorum)
1. **Solver** (Max `claude -p`): loads full context (the `ticket_messages`, customer + subs + orders, latest `ticket_analyses`, the brain brief + the live `sonnet_prompts` rules) and asks *why did this escape every rule?* Then branches (same taxonomy the reasoning pass already uses):
   - `customer_fix` → propose the resolution that **unescalates**: `customer_reply` + N `customer_action` to-dos.
   - `escalation_false_positive` → it was escalated incorrectly → propose a **spec to fix the ticket analyzer** (target `src/lib/ticket-analyzer.ts` severity thresholds / `SEVERE_ISSUE_TYPES` / `CUSTOMER_ESCALATION_KEYWORDS` / grader prompt).
   - `analysis_gap` → `ticket_analysis_rescore` (+ a grader-rule change if the pattern repeats).
   - `system_gap` → a code change → a **spec** (see tweak below).
   - `no_action` → `ticket_close`.
2. **Skeptic** (separate Max `claude -p` persona, fresh eyes — not the solver's session): independently re-examines the **brain, the rules (`sonnet_prompts`), DB settings, and the ticket** to judge: *is the issue correctly understood? is the proposed fix correct + safe + minimal?* Returns `agree | revise | reject` + a critique. It is prompted to **try to refute** the solver (adversarial), not rubber-stamp.
3. **Quorum:** **agree → materialize** the outputs. **revise →** one bounded re-loop (solver incorporates the critique, skeptic re-checks). **reject / still no agreement →** materialize **nothing**, leave the ticket escalated, and log the disagreement (so a human sees it). Quorum verdict + both transcripts are stored for audit (in the todo `payload` / a lightweight `triage_runs` record).

## Output routing (the founder's tweaks)
- **Customer fixes → `agent_todos`** (`pending`, group_id, `source_ticket_id`) — **unchanged artifact + execution**: the existing dashboard approval + Inngest customer-facing executor + `maybeAutoCloseGroup()` (which on the last todo **closes → unescalates → unassigns**). The box only *produces* the rows; execution stays as-is.
- **Prompt / grader rules → proposed `sonnet_prompts`** (`status='proposed'`, `derived_from_ticket_id`). **Approval stays at `admin` so Zach (admin) can approve prompt rules** — do NOT tighten sonnet-prompt approval to owner-only. (Zach = `admin` confirmed.)
- **Code changes + analyzer fixes → SPEC FILES, not `code_change` to-dos** (the tweak). Commit `docs/brain/specs/{slug}.md` (via the [[box-spec-chat]] finalize/commit-to-main path) carrying a **`Derived-from-ticket:`** ref + a short problem synopsis, **owner = cs** ([[../functions/cs]]), surfaced on [[../dashboard/roadmap]] to **commission a build**. The routine **never writes code or `code_change`/`escalation_rule_fix`/`brain_doc_edit` to-dos** — those become specs. (Removes the old routine's PR-opening system-execute pass entirely.)
- **Re-score → `ticket_analysis_rescore`** (forces re-analysis of the ticket).

## Retire the old routine (no dead code — the founder's ask)
This spec **deletes** the Anthropic-cloud routine concept so nothing dangles:
- **Remove:** `scripts/agent-todo-routine-run.ts`, the API-based `src/lib/agent-todos/reasoning.ts` (Opus-via-API proposer) and `system-execute.ts` (PR/Anthropic system-action executor), and the routine's cron/registration/trigger.
- **Keep (now fed by the box):** the `agent_todos` table, `/dashboard/tickets/todos`, the approval API, the Inngest **customer-facing** executor (`agent-todo-execute`), `maybeAutoCloseGroup()`, and the action types `customer_reply｜customer_action｜ticket_close｜ticket_analysis_rescore`. Drop the now-unused system-level action types (`code_change｜brain_doc_edit｜escalation_rule_fix｜sonnet_prompt_*` as *todos*) — those are specs/proposed-prompts now.
- Net: one generator (the box routine), one output table (`agent_todos`) it shares with the human/Improve flows, zero Anthropic-API ticket reasoning left.

## Data model
- **`agent_jobs`**: add `'triage-escalations'` kind + concurrency-1 lane; one hourly sweep job processes the batch. See [[../tables/agent_jobs]].
- **`agent_todos`**: reused as-is (now box-produced); prune the system-level action-type enum values that become specs. See [[../tables/agent_todos]].
- **`sonnet_prompts`**: reused (proposer = box routine; `derived_from_ticket_id`). Admin-approvable.
- **Specs**: code/analyzer fixes as `docs/brain/specs/{slug}.md` (owner=cs, ticket ref).
- **Optional `triage_runs`** (audit): solver/skeptic transcripts + quorum verdict per ticket per run.

## Roles
- Prompt-rule approval = **`admin`** (Zach), unchanged. Ticket-derived code/analyzer specs owned by **`cs`** ([[../functions/cs]], introduced in [[box-ticket-improve]]) and commissioned on Roadmap by owner/admin.

## Verification
- Force a ticket to `escalated_at=now(), escalated_to=NULL` → within the hour the box runs a `triage-escalations` job (API console flat, claude.ai/usage moves = Max). The job log shows a **solver** verdict + a **skeptic** verdict per ticket.
- A genuine customer issue → `agent_todos` group appears (`pending`, `customer_reply` + `customer_action`); approving it executes + the ticket closes/unescalates/unassigns (existing path).
- A mis-escalated ticket → **no customer todo**; instead a **spec** is committed (owner=cs, `Derived-from-ticket`) proposing an analyzer threshold/keyword fix, visible on Roadmap.
- A recurring rule gap → a `sonnet_prompts` proposal that **Zach (admin) can approve**.
- Solver/skeptic **disagree** → ticket **stays escalated**, disagreement logged, nothing materialized.
- Dead-code check: `scripts/agent-todo-routine-run.ts` + the API reasoning/system-execute passes are gone; `npx tsc --noEmit` clean; the customer-facing todo execution + dashboard still work.

## Phases
- ⏳ **P1 — box sweep + solver:** hourly cron → `triage-escalations` job, `runEscalationTriageJob` in `builder-worker.ts`, escalated-ticket selection + dedupe, the solver pass producing `agent_todos` (customer fixes) on Max. (Single-pass parity with the old routine, on the box.)
- ⏳ **P2 — skeptic + quorum:** the adversarial second pass + agree/revise/reject quorum; no-quorum → stays escalated + logged; audit transcripts.
- ⏳ **P3 — spec routing + rescore + rules:** code/analyzer fixes → specs (owner=cs, ticket ref, Roadmap); `ticket_analysis_rescore`; proposed `sonnet_prompts` (admin/Zach approval).
- ⏳ **P4 — retire old routine:** delete the Anthropic-cloud routine + system-execute, prune unused `agent_todos` action types, keep table + customer-facing execution + dashboard; tsc-clean.

## Brain updates (same PR set)
[[../tables/agent_jobs]] (`triage-escalations` kind/lane) · [[../tables/agent_todos]] (box-produced; pruned action types) · [[../lifecycles/agent-todo-system]] (routine now box-hosted solver/skeptic; old Anthropic-cloud routine retired) · [[../lifecycles/ai-analysis]] (escalation triage on the box; analyzer-fix specs) · [[../tables/sonnet_prompts]] · [[../functions/cs]] · [[../recipes/build-box-setup]] (lane + the hourly cron) · the `escalation-triage` skill page. Shares the session/quorum substrate with [[box-spec-chat]] + [[box-ticket-improve]]. On ship, fold into those pages + delete this spec.
