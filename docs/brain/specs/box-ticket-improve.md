# Box-hosted Ticket "Improve" Agent (Max session) ✅

> **Build note (execution path):** The box (Max `claude -p`) does read-only investigation + **proposes** a typed plan; **execution runs server-side in the Improve route** (`/api/tickets/[id]/improve`, which holds service-role + integration + GitHub creds — exactly where today's Improve tab already runs `runImproveActions`). This is faithful to the spec's gate (the box never mutates; execution is human-approved + runs in a trusted, cred-holding component) while reusing the proven executors, instead of a box→worker plan-handoff. Rule proposals land `proposed` (normal review). **Default chosen** for the "flag at build" open items: `cs_manager` can approve customer-action plans; the data model is the **sibling `ticket_improve_chats` table**.

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform" (same box-agent substrate as [[box-spec-chat]]; action surface from [[../lifecycles/ai-analysis]] + [[../orchestrator-tools]]). **Introduces** a CS/support ownership lane (new `functions/cs` + `cs_manager` role) for ticket-derived code specs.

Move the ticket **"Improve" tab** off the **Anthropic API** and onto the **build box** as a **long-running, resumable `claude -p` Max session**, scoped to the ticket. Today Improve (`src/app/api/tickets/[id]/improve/route.ts`) is a stateless Opus-via-API call with ~8 read-only data tools and a max-3-round tool loop. Replace it with the **same box session primitive as [[box-spec-chat]]** — but with a **much richer, approval-gated action surface**. The goal: reproduce, inside the Improve tab, the exact **terminal chat the founder has with Claude to fix a weird ticket** — discuss it, decide, and act — except now it's **super-powered on Max** (reads the whole brain + `src/` + web), the **CX manager can drive it too**, and it can **actually take the actions** with one approval.

**Outcome:** open Improve on a weird ticket → talk to Claude-on-Max that already has the full ticket + customer + orders + brain + code loaded → it recommends or proposes a fix → you approve (or redirect) → it **does everything**: customer actions, internal notes, sonnet-rule changes, re-score, and closes/unassigns/unescalates — or, for code changes, writes a **ticket-sourced spec** routed to the CS manager to commission in Roadmap.

## Ticket-binding (auto — the founder's explicit ask)
The Improve session is **pre-bound to the current ticket**. Opening the tab starts/loads the ticket's improve session with `ticket_id` baked in; **every turn's job carries `ticket_id`**, and the box loads full ticket context at session start (subject/status/tags, customer name+email+subscription+LTV+retention, last ~50 `ticket_messages`, latest `ticket_analyses`, returns/dunning/crisis/chargebacks via the existing improve data tools). **The human never states which ticket** — the window knows. Pivoting to a *different* ticket means opening Improve on that ticket (its own session).

## Feature parity (must keep — same surface, more powers)
Everything the current Improve route does still works, on the box:
- The read-only investigation tools (`get_customer_account`, `get_product_knowledge`, `get_product_nutrition`, `get_returns`, `get_chargebacks`, `get_email_history`, `get_crisis_status`, `get_dunning_status`, `get_ticket_analysis`) — now the box can *also* `Read`/`Grep` brain + `src/` and `WebSearch`.
- Proposing + executing the full **direct-action set** (`runImproveActions` / `action-executor.ts`): `partial_refund`, `create_return`, `swap_variant`, `remove_item`, `change_next_date`, `change_frequency`, `update_shipping_address`, `apply_coupon`, `skip_next_order`, `crisis_pause`, `pause_timed`, `reactivate`, `update_line_item_price`, `send_message`.
- `propose_sonnet_prompt` + `propose_grader_rule` (→ `sonnet_prompts`, `status='proposed'`, `derived_from_ticket_id`).
- Admin pre-approval fast-path (execute without a round-trip when the human already said "do it").
- **New powers:** full working-tree read + web search + a **resumable session that accumulates context**, **Max billing ($0 marginal)**, plus the new **ticket→spec routing** and **re-score** actions below.

## Mechanism (reuse the box session + the build-approval gate)
Same primitive as [[box-spec-chat]] — a resumable box `claude -p` session, one short-lived job per turn — **plus** the [[build-approval-gates]] `pending_actions` gate for anything that mutates customer/rules/tickets.
- **New `agent_jobs.kind='ticket-improve'`** in a **concurrency-1 lane** (`claim_agent_job(['ticket-improve'])`), `runTicketImproveJob(job)` in `scripts/builder-worker.ts`. `spec_slug` = the improve-session id; `instructions` = JSON `{ticket_id, session_id, mode, user_message}`.
- **🚨 Max only** — top-level `claude -p` (`env -u ANTHROPIC_API_KEY`, web search on), running a **`ticket-improve` skill** that frames the role (you are the founder's CX co-pilot fixing this ticket; brain-first; you may investigate freely read-only; to mutate anything you **propose actions for approval**, never execute silently). Runs in a repo checkout on `origin/main` for brain/code reads; reaches prod DB read-only through deterministic tools for ticket context.
- **Resumable session** stored on the improve-session row (`box_session_id`); turn 1 = framing + ticket context + first message, later turns `--resume`.

## Approval + execute model (the founder's rules)
- **Investigation is free** (read-only): the agent reads the ticket, customer, orders, brain, code, web with no gate, and **recommends**.
- **Anything that acts is approval-gated.** When the agent wants to resolve, it returns a **single proposed action plan** → the turn's job goes **`needs_approval`** carrying typed `pending_actions`:
  - `customer_action` (one per refund/return/sub-change/coupon/message…),
  - `sonnet_prompt` / `grader_rule` (rule changes),
  - `rescore` (re-analyze this ticket),
  - `ticket_spec` (code change → spec, see below),
  - `resolve_sequence` (the closeout: post internal note(s) → **close → unassign → unescalate**).
- **Approve once = do it all.** Approving the plan runs the **whole batch** via the trusted worker (the box session has no prod creds; the worker executes through `action-executor.ts`/`improve-actions.ts`, exactly like build-gate execution): every customer action, the internal messages left **in the window**, then close + unassign + unescalate. Partial approve/decline per-action is supported but the default is one-tap "do everything."
- **Pivot.** If the founder or CX manager wants something *other* than what it recommended, they **decline + type the new instruction**; the session **resumes** and does that instead (it's a conversation, not a fixed proposal). The agent never insists on its own plan over an explicit human instruction.

## Action routing specifics
- **Customer actions / messages / sonnet-prompt + grader-rule changes** → execute via the existing executors on approval (rules land as `proposed` in `sonnet_prompts` and still flow through the normal approve→`enabled` review, OR auto-approve if the human approved the plan — flag at build).
- **Re-score / AI analyzer** → a `rescore` action that forces re-analysis of THIS ticket (set `tickets.last_analyzed_at = null` so [[../inngest/ticket-analysis-cron]] re-grades on its next tick, or call `analyzeTicket(ticketId)` directly). The agent can also *work on the analyzer* by proposing `grader_rule` changes that change how tickets are scored.
- **Code changes → a ticket-sourced spec, NOT a direct build.** Because the **CX manager** uses Improve, a code recommendation becomes a `ticket_spec` action: on approval the worker writes `docs/brain/specs/{slug}.md` (committed to main like the chat finalize) carrying a **`Derived-from-ticket:` reference** (ticket id + a short problem synopsis from the conversation), **owner = the CS function**, and surfaces it on [[../dashboard/roadmap]] for the founder/CX manager to **commission the build** (the existing `kind='build'` flow). Improve **never builds code itself** — it hands a well-formed, ticket-grounded spec to Roadmap. (This is the [[box-spec-chat]] finalize path, fired from a ticket.)

## Roles (CX manager can drive it)
- Improve is `owner`/`admin`-gated today. This spec **adds a `cs_manager` workspace role** (or widens Improve to `agent`+) so the CX manager can use it, and a **`functions/cs` page** to own ticket-derived specs. Ticket-sourced specs are filtered/surfaced to the CX manager on Roadmap by `owner = cs` (and/or a `Derived-from-ticket` tag). Customer-action approval stays available to the CX manager; high-blast-radius rule/code changes can require founder co-sign (flag at build).

## Data model
- **Improve session** — reuse the [[box-spec-chat]] session machinery, ticket-scoped. Either extend [[../tables/roadmap_chats]] with `ticket_id` + a `kind` discriminator, or a sibling `ticket_improve_chats` table: `id, workspace_id, user_id, ticket_id, box_session_id, messages jsonb, turn_status (idle｜thinking｜error｜awaiting_approval), pending_plan jsonb, last_error, status, timestamps`. Default: **sibling table** (ticket-scoped lifecycle + action plan differs enough from spec-authoring). Decide at build.
- **`agent_jobs`**: add `'ticket-improve'` kind + lane; `pending_actions` carries the typed plan (reuse [[build-approval-gates]] shapes). See [[../tables/agent_jobs]].
- **`sonnet_prompts`**: unchanged (already has `derived_from_ticket_id`, `status` lifecycle).
- **`tickets` / `ticket_messages` / `ticket_analyses`**: unchanged; the worker writes through existing executors.

## UX
- Improve tab = the same chat box, now ticket-bound + box-backed: send a message → "thinking on the box… (takes a minute)" while `turn_status='thinking'` → reply lands (poll). When the agent proposes a plan, an **approval card** lists the actions (customer actions, messages, rule/spec/rescore, then close/unassign/unescalate) with **Approve all / Decline / or just type a redirect**. Internal messages it posts appear in the ticket thread. Usable by founder + CX manager.

## Verification

Pre-req: apply both migrations (`20260620150000_ticket_improve_chats.sql`, `20260620150100_workspace_role_cs_manager.sql`) and confirm the box worker is running the new `builder-worker.ts` (its `ticket-improve` lane).

- **Auto ticket-binding + Max + working-tree access.** On a weird ticket's detail page → **Improve** tab → send "what happened here?". Within ~1–2 min the reply lands and references **this exact ticket's** customer/order facts with no prompting, and cites a brain page or `src/` path it read. Expect: `agent_jobs` row `kind='ticket-improve'` goes `queued→building→completed`; `ticket_improve_chats` row for the ticket has `box_session_id` set; the Anthropic API console stays flat while claude.ai/usage moves (Max).
- **Resume.** Send a 2nd message → expect it references the earlier turn without re-stating, and `box_session_id` is unchanged. Re-open the ticket later → the full transcript is still there (DB-persisted, ticket-bound).
- **Approval-gated fix.** Send "refund the last order $X, tell them it's done, and close it" → expect `turn_status='awaiting_approval'` and an approval card listing `customer_action` (partial_refund) + `customer_action` (send_message) + `resolve_sequence`. Click **Approve all** → expect the refund executes, the external + internal messages post into the ticket thread, the ticket becomes `closed` + unassigned + unescalated, and the session flips to `status='resolved'`.
- **Calibrate.** Send "tighten the rule that caused this" → approve → expect a `sonnet_prompts` (and/or `grader_prompts`) row, `status='proposed'`, `derived_from_ticket_id` = this ticket, reviewable at Settings → AI → Prompts.
- **Re-score.** Send "re-score this ticket" → approve → expect a fresh `ticket_analyses` row for the ticket.
- **Ticket → spec.** Send "this needs a code change to fix X" → approve the `ticket_spec` → expect `docs/brain/specs/{slug}.md` committed to `main` with `**Owner:** [[../functions/cs]]` + a `Derived-from-ticket:` ref, visible on `/dashboard/roadmap` (owner chip = cs) to commission — no build auto-runs.
- **Pivot.** With a plan parked, click **Decline** (or just type "actually just send store credit instead") → expect the plan clears and (on the redirect) a new turn proposes the store-credit plan.
- **CX manager.** As a `cs_manager` member, the **Improve** tab is visible and usable; customer-action plans are approvable.
- **Negative.** Send a message, then kill the box mid-turn → expect `turn_status='error'` with `last_error` shown + a retry affordance (sending again resumes the same session).

## Phases
- ✅ **P1 — ticket-bound turn loop:** `ticket_improve_chats` session table + `ticket-improve` kind/lane + `runTicketImproveJob` (fresh+resume, auto ticket-context brief + read-only `improve-box-tools.ts` CLI), `ticket-improve` skill, Improve route rewired to enqueue-not-call-API, tab polling + "thinking" UX. Read-only investigation + recommendations.
- ✅ **P2 — approval-gated execution:** typed `pending_plan` → approval card (Approve all / per-action / Decline / type a redirect) → `improve-plan-executor.ts` runs the full batch (customer actions + messages, then close/unassign/unescalate) via existing executors; pivot/redirect by sending a new message.
- ✅ **P3 — rules + re-score + ticket→spec:** `sonnet_prompt`/`grader_rule` plan actions (→ `proposed`), `rescore` (`analyzeTicket(ticketId,"manual")`), and `ticket_spec` (commit `docs/brain/specs/{slug}.md` to main, owner=cs, `Derived-from-ticket:` ref) surfaced on Roadmap (no auto-build).
- ✅ **P4 — CS role:** `cs_manager` workspace role (`ALTER TYPE`) + [[../functions/cs]] page + Improve gate widened to `owner｜admin｜cs_manager`. Ticket-derived specs surface on Roadmap by `owner = cs` (the existing owner-chip → `/dashboard/roadmap/functions/cs` filter). Prompt/grader-rule approval stays `admin`.

## Brain updates (same PR set)
[[../tables/agent_jobs]] (`ticket-improve` kind/lane) · new improve-session table page · [[../tables/sonnet_prompts]] (ticket-improve as a proposer) · [[../lifecycles/ai-analysis]] (Improve now box-hosted + re-score trigger) · [[../orchestrator-tools]] (action surface reused by the box agent) · [[../tables/workspace_members]] (`cs_manager`) · new [[../functions/cs]] · [[../recipes/build-box-setup]] (lane) · the `ticket-improve` skill page. Shares the session primitive with [[box-spec-chat]]. On ship, fold into those pages + delete.
