# Agent To-Do system

Replace synchronous ticket-by-ticket handling with an async approval queue. A **Claude Code Routine** (Anthropic's cloud-hosted scheduled-agent product, not an Inngest cron) reasons about escalated tickets using the brain + DB every hour, proposes concrete actions (replies, sub mutations, refunds, return labels, new Sonnet rules, brain edits, code changes), and writes them as todos to an approval queue. Dylan + Zach review the queue on `/dashboard/tickets/todos`. Approval triggers execution; rejection routes the ticket to a Claude-chat session for manual handling.

**Business outcome:** today Dylan spends 2-3 hours/day handling escalated tickets and the structural fixes those tickets surface. The system reduces that to ~30 minutes/day of approval clicks while preserving Dylan-level judgment on every customer touch and every system change. The routine never executes customer-facing actions or system changes without explicit human approval.

## Runtime — where this lives

Two cooperating runtimes, by design:

| Runtime | Role | Where | Cadence |
|---|---|---|---|
| **Claude Code Routine** (`/dashboard/code/routines` in the Claude desktop app, configured at `claude.ai/code/routines`) | Reasoning + system-level execution: scans escalated tickets, proposes todos, executes approved system actions (sonnet_prompt inserts, brain edits via PR, code changes via PR), runs CI gate before PR open | Anthropic-managed cloud (clones the repo at run start, has git access, has Read/Edit/Write/Bash tools) | **Hourly** (Claude Code Routines have a 1-hour minimum schedule interval — confirmed 2026-06-04 via docs) + API-trigger endpoint for on-demand fires |
| **Inngest event worker** (`agent-todo-execute`) | Customer-facing immediate execution: fires on approve API for `customer_reply`, `customer_action`, `ticket_close`. Drift-check + dispatch to `sendTicketReply`/`subRemoveItem`/`createFullReturn`/etc. | Vercel serverless (same as `sonnet-prompt-auto-review` etc.) | Event-triggered; no schedule |

**Why the split:**
- Customer replies can't wait an hour after approval. Inngest event worker fires within seconds.
- Code + brain changes need actual git access (commit, push, PR open). Only the Claude Code Routine has that — the Inngest function runs in a serverless container without the repo checked out.
- Sonnet prompt changes are DB inserts — could go through either path; routine handles them so all "system" changes ship through one runtime.

**Routine setup requirements** (one-time, per workspace):
- Repo configured on the routine (shopcx). Default-branch clone at run start.
- **Environment variables**: Anthropic does NOT expose an API/CLI to set Routine env vars programmatically (verified 2026-06-04). The only mechanism is the textarea at `claude.ai/code/routines` → Edit → Select environment → Environment variables (KEY=value, newline-separated). To minimize the manual step:
  - Build a `scripts/print-routine-env.ts` helper that reads `.env.local`, filters to the keys the Routine actually needs (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `APPSTLE_*`, `EASYPOST_API_KEY`, `META_*`, `BRAINTREE_*`, `KLAVIYO_*`, `SHOPIFY_*`), and emits them in the exact textarea format.
  - Usage: `npx tsx scripts/print-routine-env.ts | pbcopy` → paste into the textarea → done.
  - Rerun the script + paste whenever env vars rotate. Workaround until Anthropic ships an env API.
- **Shared environment**: create one named environment ("shopcx-production") in `claude.ai/code/routines` and reuse it across every future Routine in the workspace. The copy-paste happens exactly once per rotation, not per routine.
- Branch push policy: default `claude/`-prefixed branches OK; "Allow unrestricted branch pushes" stays OFF (no direct-to-main from the routine).
- Model: Opus (matches the existing orchestrator quality bar for ticket reasoning).
- Triggers: schedule (hourly) + API endpoint (for on-demand wake from approval API on system-level todos).

## Phase 0 — Schema + migration ⏳

- ⏳ New table `agent_todos`:
  ```
  id uuid PK
  workspace_id uuid → workspaces.id
  source text                                   -- 'ticket' | 'csat' | 'cron' | 'manual'
  source_ticket_id uuid → tickets.id (nullable)
  group_id uuid                                 -- links N todos from one logical fix
  action_type text                              -- enum below
  payload jsonb                                 -- action-specific (reply HTML, mutation params, diff)
  summary text                                  -- short label for list view
  context_what_happened text                    -- plain-English customer-side narrative
  context_what_we_propose text                  -- plain-English fix narrative
  pre_exec_context jsonb                        -- snapshot for drift detection
  confidence real
  urgency text                                  -- 'urgent' | 'normal' | 'low'
  status text                                   -- 'pending' | 'approved' | 'executed' | 'rejected' | 'superseded' | 'failed'
  approved_by uuid → auth.users.id (nullable)
  approved_at timestamptz
  approval_role text                            -- 'owner' | 'admin'
  executed_at timestamptz
  execution_result jsonb
  rejected_at timestamptz
  rejected_by uuid → auth.users.id
  reject_reason text
  routine_run_id uuid (nullable)                -- which routine pass proposed this
  created_at timestamptz default now()
  updated_at timestamptz default now()
  ```
- ⏳ `action_type` enum:
  - `customer_reply` — outbound message on the source ticket
  - `customer_action` — sub mutation / refund / return label / loyalty apply / store credit / pause
  - `ticket_close` — for false-positive escalations
  - `sonnet_prompt_new`
  - `sonnet_prompt_edit`
  - `ticket_analysis_rescore` — update an existing `ticket_analyses` row's score/summary/issues when the analyzer got it wrong (e.g. it scored a clean ticket 5/10 because of a misread)
  - `grader_prompt_edit` — propose a change to the per-ticket analyzer's grading rules (the prompts that produce `ticket_analyses`)
  - `escalation_rule_fix` — propose tightening or fixing the auto-escalation triggers (threat-language detector, severe-issue detector, etc.) when a false-positive pattern shows up across multiple tickets
  - `brain_doc_edit`
  - `code_change`
- ⏳ Index on `(workspace_id, status, created_at desc)` for list-view paging.
- ⏳ Index on `(source_ticket_id)` for the linked-todos block on detail page.
- ⏳ `scripts/print-routine-env.ts` — reads `.env.local`, filters to the Routine's needed keys (Supabase / Anthropic / Resend / Appstle / EasyPost / Meta / Braintree / Klaviyo / Shopify), prints `KEY=value\n` block to stdout. Pipe to `pbcopy`; paste into the Routine's environment-vars textarea once. Avoids 25-row copy-paste; rerun when secrets rotate.

## Phase 1 — The hourly Claude Code Routine ⏳

Routine name: `agent-todo-routine`. Schedule: hourly. Trigger surface includes API endpoint (for wake-on-approval of system-level todos).

### Escalation routing change (prereq)

Today the unified-ticket-handler sets `tickets.escalated_to` to a human user UUID at three sites (`src/lib/inngest/unified-ticket-handler.ts:491, 1261, 1673`). With the To-Do system, escalations route to the routine, not to a human.

- ⏳ Change those three sites: set `escalated_to = null` (and `assigned_to = null`) when the orchestrator escalates. The routine picks up everything where `escalated_at IS NOT NULL` AND no active todo group exists.
- ⏳ Dashboard "escalated to me" filter unchanged in behavior — it still filters by `escalated_to = current_user.id`, which means by default it shows nothing (everything escalates to routine first).
- ⏳ On `POST /api/todos/[id]/reject` — if all todos in the group are rejected, update the source ticket: `escalated_to = workspace_owner.user_id` AND add tag `todo:rejected`. **Always escalates to owner**, regardless of who clicked reject. Zach can reject a customer message, but the resulting "needs manual handling" ticket lands in Dylan's inbox — Dylan handles all manual ticket work going forward.

### Per run



1. **Reasoning pass** — for each open or recently-closed ticket where `escalated_at IS NOT NULL` AND no `agent_todos` row with status in `('pending','approved','executed')` exists for that ticket:
   - Load full ticket context: messages, customer record, subs, recent orders, AI analysis, active crisis enrollment if any.
   - Read the brain pages relevant to the message intent (`customer-voice.md`, `operational-rules.md`, the ticket-lifecycle, any matching playbook lifecycle).
   - Use Opus to reason about: what did the customer want, what did the AI do, what's the gap, what's the fix.
   - Decide one of:
     - **No action needed** (false-positive escalation) → propose single `ticket_close` todo with urgency=low.
     - **Customer fix needed** → propose linked todos: 1× `customer_reply` + N× `customer_action` (one per mutation), all sharing the same `group_id`.
     - **System gap** → additionally propose linked `sonnet_prompt_*`, `brain_doc_edit`, or `code_change` todo with the same `group_id`. These are owner-approval only.
     - **AI-analysis gap** → if the existing `ticket_analyses` row scored the ticket wrong (e.g. clean ticket scored 5/10 due to a misread, OR a real issue scored 10/10 because the grader missed it), propose a `ticket_analysis_rescore` todo with the corrected score + summary + issues. If the misread reflects a pattern (multiple tickets the grader scored similarly wrong this run), additionally propose a `grader_prompt_edit` to tighten the grader.
     - **Escalation false-positive pattern** → when ≥2 tickets in this run are flagged as false-positive escalations triggered by the same auto-flag rule (e.g. three tickets escalated for "threat language" when no threat exists), propose an `escalation_rule_fix` todo describing the tightening (specific regex / keyword removal / prompt change).
   - Write `context_what_happened` (1 short paragraph) and `context_what_we_propose` (one paragraph or short bulleted list) so Zach can act without reading the conversation.
   - Capture `pre_exec_context` (latest_inbound_message_id, sub state hash, etc.) for drift detection.
2. **System-level execution pass** — the routine executes approved system-level todos. (Customer-facing approvals don't wait — they're handled by the Inngest event worker described in Phase 4.)
   - For each `approved` todo where `action_type IN ('sonnet_prompt_new','sonnet_prompt_edit','ticket_analysis_rescore','grader_prompt_edit','escalation_rule_fix','brain_doc_edit','code_change')`:
     - **sonnet_prompt / ticket_analysis_rescore / grader_prompt_edit**: DB insert/update via Supabase service-role client. Record the new row id in `execution_result`.
     - **brain_doc_edit**: edit the markdown file in the cloned repo → run `npx tsc --noEmit` (no-op for docs but good safety habit) → commit on `claude/agent-todo-{timestamp}-{slug}` branch → push → open PR via `gh pr create` or GitHub API. Record `pr_url` in `execution_result`. Optional `auto_merge=true` flag on the todo: after CI passes, auto-merge.
     - **code_change**: same flow but **never auto-merge**. The diff is in the todo payload; apply it, run `npx tsc --noEmit`, run any unit tests we wire in, only push if all green. If CI fails → mark todo `failed` with the error output in `execution_result`, do NOT push a broken branch.
     - **escalation_rule_fix**: typically code-adjacent (the threat-detector prompt or the auto-flag thresholds live in code) → goes through the code_change PR path.
   - Skip drift check on system-level execution (system actions don't depend on the customer's latest message).
   - On failure → `status='failed'` with error; do NOT auto-retry.
3. **Auto-closure pass** — for each `source_ticket_id` where all customer-facing todos (`customer_reply` + `customer_action`) in the group are `executed`:
   - Update `tickets`: `status='closed'`, `escalated_at=null`, `assigned_to=null`, `closed_at=now()`.
   - Insert system note in ticket_messages: *"[System] Resolved via To-Do system. Approved by {role} {name} at {time}."*
   - System-level todos (`sonnet_prompt_*`, `brain_doc_edit`, `code_change`, etc.) do NOT block ticket closure. They can be approved + executed later without touching the customer.

4. **Merged-PR cleanup pass** — for each `brain_doc_edit` / `code_change` todo with status='executed' and `pr_url` populated:
   - Query GitHub API for merge status of the PR.
   - If merged → todo gets a final tag in `execution_result.merged_at`. (Nothing else changes; the ticket was already closed at the customer-facing layer.)
   - If closed-without-merge → todo gets `status='rejected'` with reason `pr_closed_without_merge`. (Treated as a rejection so it doesn't sit in "executed" forever as a phantom completion.)

**Safety invariants — non-negotiable:**
- The routine NEVER executes a customer-facing or system-level action without a `status='approved'` row.
- The routine NEVER auto-retries failed executions.
- The routine NEVER approves its own proposals.
- Drift check MUST run immediately before execution; expired-context approvals supersede silently.
- For each ticket, only ONE active group of todos at a time. If a routine sees an existing pending/approved group, skip — don't propose a duplicate.

## Phase 2 — Dashboard list view ⏳

Route: `/dashboard/tickets/todos`. Sidebar link: Tickets → **To Do** with role-scoped bubble count.

- ⏳ **List columns:** urgency dot, customer name, summary (1 line), action types (badges), proposed_at, approval state, group indicator.
- ⏳ **Filters:** status (default = pending), urgency, action_type, source (ticket / cron / etc.), assigned-to-me-role (toggle "items I can approve").
- ⏳ **Group rendering:** todos sharing a `group_id` collapse into one row by default; expand to see each individual todo.
- ⏳ **Bubble count = items the current viewer can approve.** For Dylan: all pending. For Zach: pending where `action_type IN ('customer_reply','customer_action','ticket_close')`.
- ⏳ **Visibility ≠ approval.** Zach sees everything, including owner-only todos. Owner-only rows render with *"Needs owner access to approve"* instead of approve/reject buttons.

## Phase 3 — Dashboard detail view ⏳

Route: `/dashboard/tickets/todos/[id]`.

- ⏳ **Header:** customer, LTV, source ticket subject + id, escalation reason.
- ⏳ **"What happened" block** — pulls from `context_what_happened` (plain English, 1 paragraph).
- ⏳ **"What we propose" block** — pulls from `context_what_we_propose` (plain English, may be bulleted).
- ⏳ **Linked todos panel** — shows every todo in the same `group_id`. Each row: action_type badge, summary, approval state, approver name + role + time when not pending. Approve / Reject buttons inline per row; or "Needs owner access" greyed pill if the viewer's role can't approve that type.
- ⏳ **Action preview** — for `customer_reply`, render the HTML message inline (read-only) so the approver sees exactly what the customer would see. For `customer_action`, render a structured diff (e.g. "Remove Strawberry Lemonade from sub 946db2fd / next billing 2026-06-24"). For `sonnet_prompt_*`, render the rule content as a diff against any existing prompt. For `brain_doc_edit` and `code_change`, render the unified diff.
- ⏳ **Conversation appendix** — collapsed by default. Click to expand the full ticket_messages log. This exists for verification, not for primary comprehension; the two context blocks above should be enough.

## Phase 4 — Approval API + execution ⏳

- ⏳ `POST /api/todos/[id]/approve`
  - Auth: `workspace_members.role` of the caller must allow the `action_type`.
  - Set `status='approved'`, stamp `approved_by/at/role`.
  - **For customer-facing actions** (`customer_reply`, `customer_action`, `ticket_close`) → fire `inngest.send('agent-todo/execute', { todo_id })` for immediate Inngest event-worker execution. Drift-check runs inside the worker.
  - **For system-level actions** (sonnet_prompts / brain / code / analysis / escalation_rule / grader) → either:
    - (a) Wait for the next hourly Claude Code Routine tick to pick it up (acceptable for most), OR
    - (b) **POST to the routine's API-trigger endpoint** with `{ todo_id }` to wake the routine on-demand (use when the approval is urgent — e.g. a tightening of the threat-detector that's actively producing false-positive escalations).
    - First cut: always wake the routine on system-level approvals. Cost is minor; latency win is real. Can downgrade to "wait for hourly tick" if cost grows.
  - Return the updated todo for optimistic UI refresh.
- ⏳ `POST /api/todos/[id]/reject`
  - Auth: same role gate as approve.
  - Set `status='rejected'`, stamp `rejected_by/at`, save `reject_reason` (optional text from the dialog).
  - **Ticket is NOT auto-closed on reject.** It stays in its current escalated state so Dylan can pick it up in a Claude-chat session.
  - If all todos in the group are rejected, add a tag to the source ticket: `todo:rejected` so Dylan can filter the rejected pile from the regular ticket inbox.
- ⏳ Inngest worker `agent-todo-execute` (event `agent-todo/execute`):
  - **Handles only customer-facing action types** (`customer_reply`, `customer_action`, `ticket_close`). System-level actions are routine territory.
  - Load todo.
  - Drift check via `pre_exec_context`. If a new inbound message landed on the source ticket between approval and execution, mark `status='superseded'` and stop.
  - Dispatch by `action_type` to the right helper (`sendTicketReply`, `subRemoveItem`, `createFullReturn`, etc.).
  - Update `status` + `execution_result` based on outcome.
  - If this was the last unexecuted customer-facing todo in the group → run auto-closure step from Phase 1.

## Phase 4.5 — Escalated dashboard view rebuild ⏳

The existing `/dashboard/tickets/escalated` view filters by `escalated_to = current_user.id` — under the new model that filter is wrong (most escalations are routine-bound with `escalated_to = NULL`). Rebuild it as the **observability surface** for the whole escalation pipeline. The To-Do queue stays the primary action surface; this is the at-a-glance pipeline health view.

- ⏳ **Drop the `escalated_to = current_user.id` filter.** Show every ticket where `escalated_at IS NOT NULL`, sorted by `escalated_at desc`.
- ⏳ **Add a "Routed to" column** with a status badge per row:
  - `routine` (gray) — no todos created yet; awaiting the next routine pass
  - `todo:pending` (amber) — group has pending todos
  - `todo:approved` (blue) — todos approved, awaiting execution
  - `rejected → {first_name}` (red) — at least one todo rejected, escalated_to set to that user
  - `assigned → {first_name}` (zinc, legacy) — assigned to a human under the pre-routine model
- ⏳ **Filter chips at the top** (counts in parens):
  - `All`
  - `Routine pending` — escalated, no todo group exists yet
  - `Awaiting approval` — at least one `pending` todo in the group
  - `Approved, pending execute` — all approved but not all executed
  - `Rejected → me` — at least one rejected todo, `escalated_to = current_user.id`
  - `Assigned to human (legacy)` — `escalated_to` is some other user, no todos in flight
- ⏳ **Sidebar bubble change.** The "Escalated" sidebar item's count badge changes meaning:
  - Old: count of tickets with `escalated_to = current_user.id`
  - New: count of tickets in the **"Rejected → me"** chip — the pile that needs human thinking, not algorithmic processing
  - This is intentionally different from the To-Do bubble (which is "items in your approval queue"). Together: To-Do bubble = "approve these"; Escalated bubble = "think about these."
- ⏳ **Default chip:** `Awaiting approval` if it has rows, otherwise `All`. Optimizes for the most actionable view.

## Phase 4.7 — Branches surface ⏳

The routine creates PRs on `claude/`-prefixed branches whenever a `brain_doc_edit` or `code_change` (or `escalation_rule_fix` / `grader_prompt_edit` that lands as code) executes. Dylan needs a single surface to see all open PRs the routine has created.

- ⏳ **Inline on the To-Do detail page** — when execution result includes `pr_url`, render a card: PR title, file count, CI status (pulled from GitHub), age, **Open in GitHub** button. This is the "PR for this todo I just approved" view.
- ⏳ **New `/dashboard/branches` page** — list all open `claude/*` PRs on the shopcx repo via GitHub API. Columns:
  - Title
  - Source todo (link back to the todo that created it — match via `pr_url`)
  - Age
  - CI status (passing / failing / pending)
  - Mergeability
  - **Open in GitHub** button
- ⏳ **Sidebar item "Branches"** under top-level dashboard, with bubble count = number of open `claude/*` PRs.
- ⏳ **Auto-merge flag per category** (workspace setting):
  - `auto_merge_brain_docs`: default false. When true, brain doc PRs auto-merge once CI passes. Low-risk; reverts via git if needed.
  - `auto_merge_code_changes`: ALWAYS false. Hard-coded. Code never auto-merges.
- ⏳ **CI gate** — the routine runs `npx tsc --noEmit` (and any tests wired in) BEFORE pushing. If it fails, no PR opens; the todo gets `status='failed'` with the compile error in `execution_result.error`. No broken PRs make it to the Branches surface.

## Phase 5 — Backfill + first run ⏳

- ⏳ One-shot reasoning pass: for each currently-escalated ticket (the 7 in the queue right now), run the routine's reasoning pass once and write its todos. Confirms the pipeline end-to-end on real data before going live.
- ⏳ Verify Millie's return label proposal lands in the queue (her ticket is in the backfill set).
- ⏳ After backfill validates, enable the hourly schedule on the routine in `claude.ai/code/routines`.

## Phase 6 — Brain index updates ⏳

- ⏳ Update `docs/brain/specs/README.md` Active Project 1-3 to mention the To-Do system as their common feedback surface (since it'll route fixes back into each project).
- ⏳ New brain page: `docs/brain/dashboard/tickets__todos.md` (list view).
- ⏳ New brain page: `docs/brain/dashboard/tickets__todos__id.md` (detail view).
- ⏳ Update brain page: `docs/brain/dashboard/tickets__escalated.md` — document the rebuilt observability view with the 6 chips + new bubble semantics.
- ⏳ New brain page: `docs/brain/dashboard/branches.md` — the Branches surface listing open `claude/*` PRs.
- ⏳ New brain page: `docs/brain/tables/agent_todos.md`.
- ⏳ New brain page: `docs/brain/inngest/agent-todo-routine.md`.
- ⏳ New brain page: `docs/brain/lifecycles/agent-todo-system.md` (the end-to-end trace). After this spec ships, fold the spec content here and delete the spec per project-management convention.

## Safety / invariants

- **Approval gate is non-negotiable.** No action executes without a `status='approved'` row and a matching `approved_by/role`.
- **Role-gated approval.** Permissions matrix:
  | action_type | Approver |
  |---|---|
  | `customer_reply`, `customer_action`, `ticket_close` | owner OR admin |
  | `ticket_analysis_rescore` | owner OR admin (it's per-ticket data correction, not a system-wide change) |
  | `sonnet_prompt_new`, `sonnet_prompt_edit` | owner only |
  | `grader_prompt_edit`, `escalation_rule_fix` | owner only |
  | `brain_doc_edit`, `code_change` | owner only |
- **Visibility ≠ approval.** Both roles see all todos. Approval buttons are gated; non-approvers see a *"Needs owner access to approve"* indicator.
- **Drift detection.** Every execution worker re-fetches the latest ticket state and compares against `pre_exec_context`. If the customer replied between approval and execution, supersede silently and re-propose next pass.
- **One active group per ticket.** Reasoning pass skips tickets that already have a pending or approved group of todos.
- **Customer-facing immediate (Inngest), system-level via Routine.** Approving a `customer_reply` fires within seconds via the Inngest event worker. Approving a `sonnet_prompt_edit` or `code_change` either waits for the next hourly Routine tick or is woken on-demand by POSTing to the Routine's API endpoint. Keeps customer reply latency low while preserving the Routine's git access for system changes.
- **No direct-to-main pushes from the Routine.** Branch push policy restricts the Routine to `claude/`-prefixed branches. Code merges to main are always human-driven (you reviewing the PR in GitHub).
- **CI gate before PR.** Code-change todos run `npx tsc --noEmit` and tests inside the Routine BEFORE pushing. If CI fails, todo is `failed` with the error captured; no PR opens. No broken branches accumulate.
- **Routine is stateless between runs.** Each tick is a fresh cloud session with a clean filesystem. State lives in `agent_todos` (Supabase). The Routine queries the table at run start to know what's been processed.
- **No silent retries on failure.** A `failed` todo stays failed and surfaces in the queue with the error; humans decide next step.
- **Rejection always escalates to owner, not rejecter.** When ALL todos in a group are rejected, the source ticket's `escalated_to` is set to the workspace owner's user_id — never the rejecter's. Dylan handles all manual ticket work via Claude chat regardless of which role clicked reject.
- **Escalations route to the routine, never to humans by default.** Orchestrator escalation sets `escalated_to = NULL`. Humans only see escalated tickets after they reject a todo, at which point `escalated_to` is set to the rejecter's user_id and the ticket appears in their "escalated to me" inbox.

## Completion criteria

- ⏳ Schema migration applied; `agent_todos` table exists with all columns + indexes.
- ⏳ `scripts/print-routine-env.ts` works: `npx tsx scripts/print-routine-env.ts` outputs the filtered KEY=value block ready to paste into the Routine's environment textarea.
- ⏳ Claude Code Routine `agent-todo-routine` created at `claude.ai/code/routines` with hourly schedule + API trigger + env vars + repo configured.
- ⏳ Inngest event worker `agent-todo-execute` registered for customer-facing immediate execution.
- ⏳ The 7 currently-escalated tickets each have a populated todo group after backfill.
- ⏳ `/dashboard/tickets/todos` list view renders, role-scoped bubble count works.
- ⏳ `/dashboard/tickets/todos/[id]` detail view renders all blocks (what happened, what we propose, linked todos, action preview, collapsed conversation).
- ⏳ Approve fires immediate execution for `customer_reply` via Inngest worker; the customer sees the message within ~30s of click.
- ⏳ Approve on `sonnet_prompt_new` either waits for hourly Routine tick or wakes the Routine via API trigger; executed.
- ⏳ Approve on `brain_doc_edit` or `code_change` results in a `claude/`-prefixed PR opening with the diff; PR URL stored in `execution_result.pr_url`; To-Do detail page shows the PR card; `/dashboard/branches` lists it.
- ⏳ CI gate works: a deliberately broken code_change todo fails `npx tsc --noEmit` and no PR opens.
- ⏳ Reject marks todo + ticket; doesn't auto-close ticket.
- ⏳ Customer-facing group execute → ticket auto-closes + unescalates + unassigns + system note added.
- ⏳ `/dashboard/tickets/escalated` shows ALL escalated tickets (no `escalated_to=me` filter), with chip filters and a "Routed to" badge per row. Sidebar bubble counts the "Rejected → me" pile, not the routine-bound pile.
- ⏳ Brain pages written; spec content folded into `lifecycles/agent-todo-system.md`; this spec file deleted.

## Open questions

- **Bubble-count refresh cadence.** Real-time via supabase realtime, or poll every N seconds? Lean realtime if it's cheap.
- **Failed-todo replay.** Right now manually inspect + decide. If the failure rate stays high we may want a "retry" button on the detail view. Start without and revisit after first month of data.
- **Multi-routine coordination.** This spec assumes one routine. Future: CSAT-driven todos, sub-health-driven todos, etc. Should be additive — the routine name + reasoning logic differ, but the table + dashboard surface stays one.
- **Sub-hourly cadence.** Claude Code Routines minimum schedule is 1 hour. If we ever need faster reasoning passes, the option is: cron job (Inngest, every 30 min) POSTs to the Routine's API endpoint to wake it. Costs more but bypasses the schedule floor. Skip for first cut.
- **GitHub App permissions.** The Routine commits + pushes via your GitHub identity (Claude GitHub App). Verify the Claude app is installed on `thecyclecoder/shopcx` with `claude/`-prefixed-branch push permission and PR-open permission.

## Related

[[../tables/tickets]] · [[../tables/ticket_messages]] · [[../tables/ticket_analyses]] · [[../tables/sonnet_prompts]] · [[../lifecycles/ticket-lifecycle]] · [[../lifecycles/ai-learning]] · [[../customer-voice]] · [[../operational-rules]] · [[../project-management]]
