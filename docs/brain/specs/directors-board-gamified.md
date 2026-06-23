# Gamified #directors board (Messages) ⏳

**Owner:** [[../functions/platform]] · **Parent:** M3 — Gamified #directors board
**Blocked-by:** [[agents-hub-role-inboxes]]

The **Messages** tab of the M1 inbox, built as a Slack-style **team channel** — not a log. Each director is a **character** (name, personality, color, SVG mascot from the [[agents-hub-role-inboxes]] persona module) posting conversationally: *"🛠️ Ada · Platform — squashed a 500 on the portal path, all green; escorting the Acquisition goal, 3/5 milestones down 💪"*. It's **two-way**: the CEO replies, `@`-mentions, or asks "why?" and the director answers — wired to the existing "answer why" brains (**dev-ask** [[../libraries/dev-message-threads]] for read-only investigation, **spec-chat** [[../libraries/roadmap-chats]] for spec context). Each director carries an **XP card** (specs shipped · bugs fixed · goals escorted · streak), and the day closes with an **EOD recap** standup post (*"Shipped 8 specs · advanced 1 goal · fixed 2 bugs · approved 4 migrations"*), extending the existing daily-report pattern ([[../libraries/daily-analysis-report]] `generateDailyReport`, today ticket-only) to a director standup. Today none of this exists — [[../tables/dashboard_notifications]] is a generic bell, with no personas, no board, no XP. Success metric served: the CEO **reads the board + the daily recap, not the details** — the human-legible top layer that makes the offload trustworthy.

## Phase 1 — the board store + conversational posts ⏳
- ⏳ planned
- `director_messages` (columns: `id`, `workspace_id`, `author_function` / `author='ceo'`, `body`, `kind` ∈ `update｜reply｜recap｜approval-note`, `parent_message_id` (threading), `mentions text[]`, `metadata jsonb`, `created_at`) backing the Messages tab. Brain page [[../tables/director_messages]] (probe live schema first per [[../README]]).
- Render the channel in the M1 Messages tab: each post shows the author's persona chip + mascot ([[agents-hub-role-inboxes]] `agent-personas`), conversational human-readable body, timestamps, threads. The Platform director (M4) is the first real author; until then a seeded/system post proves the surface.

## Phase 2 — two-way reply wired to dev-ask / spec-chat ⏳
- ⏳ planned
- The CEO replies / `@`-mentions a director / asks "why?" in-thread → route to the existing answer brains: **dev-ask** ([[../libraries/dev-message-threads]] `createThread`/`markThreadThinking` → box `dev-ask` [[../tables/agent_jobs]] kind) for read-only investigation, **spec-chat** ([[../libraries/roadmap-chats]]) when the question is about a spec. The director's answer posts back into the thread as a `reply` message — no new LLM plumbing, reuse the box sessions.
- `turn_status` (thinking/idle) surfaced inline so a pending "why?" shows the director is investigating, mirroring the dev-message-center thinking state.

## Phase 3 — per-director XP card ⏳
- ⏳ planned
- A derived XP view per function: **specs shipped** (merged builds owned by the function), **bugs fixed** (repair-agent / error-fix approvals it handled), **goals escorted** (milestones advanced — M4's job), **streak** (consecutive active days). Compute from existing signals — [[../tables/agent_jobs]] (merged builds, kinds), the M2 [[../tables/approval_decisions]] log, and [[../libraries/brain-roadmap]] goal/milestone completion — no new event capture where a count is already derivable.
- Render as a card on the director's row in the M1 Agents hub + atop its board channel.

## Phase 4 — the EOD recap standup post ⏳
- ⏳ planned
- A daily job (cron, mirroring [[../inngest/daily-analysis-report-cron]]) that, per active director, composes a standup recap from the day's activity (`approval_decisions`, merged builds, milestones advanced) and posts a `recap` message to the board **and** the M1 **Daily Summaries** tab. Extends [[../libraries/daily-analysis-report]] `generateDailyReport`'s aggregate-then-narrate shape to the director domain.
- The CEO recap is a roll-up across all directors (the company standup).

## Safety / invariants
- **Personas are reskinnable config.** Names/mascots/colors come from the M1 `agent-personas` module — never hardcoded per component ([[../operational-rules]]).
- **Human-readable, not a log.** Posts are conversational prose (the goal § board), respecting the AI-voice rules where customer-facing tone matters; this is an internal owner channel, but stays plain and scannable.
- **Reuse the answer brains.** Two-way replies route to the existing dev-ask / spec-chat box sessions — do not stand up a parallel LLM chat path.
- **XP is derived, not gospel.** XP counts read from existing truth (jobs, decisions, goal completion); they are a **gamified proxy**, never an objective the directors optimize ([[../operational-rules]] § North star) — display-only.
- **Owner-only.** The board is the owner's channel for now (M1 owner-only sidebar); no member write access.

## Completion criteria
- A `director_messages` store backs the Messages tab; directors post conversational, persona-styled, human-readable updates with threading + mentions, with a brain page.
- Two-way reply / `@`-mention / "why?" routes to dev-ask + spec-chat and posts the answer back in-thread, reusing the existing box sessions.
- Each director shows an XP card (specs shipped · bugs fixed · goals escorted · streak) derived from existing signals.
- An EOD recap standup posts daily per director (+ a CEO roll-up) to the board and the Daily Summaries tab, extending the daily-report pattern.
- Brain pages written + cross-linked from [[../goals/devops-director]].

## Verification
- On `/dashboard/agents` Messages tab, expect a Slack-style channel: persona chip + mascot per post, conversational body, timestamps, threaded replies — populated once the M4 director (or a seed) posts.
- Reply to a director's post with "why did you approve that migration?" → expect a `dev-ask` job to spin up (thread shows a thinking state), and the director's answer to post back as a threaded `reply`.
- Open a director's XP card → expect specs-shipped / bugs-fixed / goals-escorted / streak counts that reconcile against [[../tables/agent_jobs]] merged builds + [[../tables/approval_decisions]] for that function.
- After the daily recap cron runs, expect a `recap` post on the board and an entry in the Daily Summaries tab summarizing the day ("Shipped N · advanced M goals · fixed K bugs · approved J migrations").
