# DevOps Director & the Agent Org

**Outcome:** take the CEO (you) out of platform operations. Stand up the **Agent Org** — CEO → Directors → Workers — with a single **approval-routing inbox** (approvals flow *up to the first live boss, else the CEO*), a **gamified Slack-style message board**, and the first live director: the **Platform/DevOps Director**, who investigates + auto-approves the platform work you currently rubber-stamp (error fixes, db builds, migrations), **escorts approved goals through their milestones**, watches the whole system, and **reports up in human terms** — escalating only the genuinely high-stakes calls. North-star chain made real: **CEO → Director → tool** ([[../operational-rules]] § North star). The `platform` function ([[../functions/platform]]) becomes an active supervising agent; this is a real step toward [[ceo-mode]].

**Why now:** unlike Growth (objective still being shaped), Platform's tools are **mature** — [[../specs/repair-agent|repair]], [[db-health-agent]], [[coverage-auto-register-agent|coverage-register]], the builder chain, the box. The director just supervises tools that already work. And the **routing inbox pays off immediately** — even before any director is automated, it consolidates every approval you currently chase across Control Tower / spec cards / the box page into **one CEO inbox**.

**Success metric:** **% of platform approvals you never have to touch** (auto-handled by a live director, with audited history) trending up; **goals escorted to completion without CEO babysitting**; **mean time-to-approve** down; zero dropped/stuck approvals. You read the board + the daily recap, not the details.

**Target:** decompose + sequence via the [[../specs/goal-decomposition-engine|goal decomposition engine]] (human-gated). This doc is the seed + design contract.

## The keystone — approvals route UP the org chart to the first live boss, else CEO
Every agent/tool has an owner function (its director). When it needs sign-off, the approval routes to **that director if it's live + autonomous** — else it **flows up to the CEO** (you). A per-function **`live + autonomous` flag** is the progressive-offload switch:
- **Today** no director is automated → **everything lands in the CEO inbox** (formalizing today's reality into one place).
- As each director comes online, its owned approvals **silently re-route to it**; with autonomy, it **auto-approves + logs an auditable decision** (supervisable autonomy — the CEO can always see what the proxy decided, and why).
- *Example:* the [[storefront-optimizer]]'s experiment proposals route to the **CEO inbox today** (Growth not live); once Growth Director is live + autonomous, the same proposals route to **Growth**, who auto-approves → you see it in history, never in your queue.

This **replaces every scattered approval surface** (Control Tower feeds, spec cards, the box `approvalHref` deep-links + their 404s) with **one inbox per role**.

## The inbox (each role — CEO + every Director — gets the same shape)
Three filterable tabs: **Messages** (the board) · **Approval Requests** (the routed queue, with the agent's *investigation + proposed fix* inline so a decision is one read) · **Daily Summaries** (EOD recaps). Owner-only sidebar for now.

## The activity log — one timestamped source of truth (powers history + board + recap)
Every director writes a **timestamped `director_activity` row on each action** it takes (approved migration X, fixed bug Y, escorted goal Z to milestone N — with the reasoning). That single log is the substrate for **(1)** the autonomous-approval **audit history** (M2), **(2)** the **board posts** (M3), and **(3)** the **EOD recap** — a read over *today's* rows. The recap is never hand-maintained; it's a query over the day's activity.

**The EOD recap is two layers:** a **one-line standup post** in the board (*"Shipped 8 specs · advanced 1 goal · fixed 2 bugs · approved 4 migrations"*) **and its own human-readable detail page** you click into — a readable narrative of the director's day (what it fixed and why, which goal it moved and how far, what it escalated), generated from that day's `director_activity` rows. **Future (later — not now):** once the **CEO is automated**, it reads across *all* directors' daily activity into a single **CEO roll-up report** it consumes — the same pattern one level up. We'll design that when we get there.

## The gamified `#directors` board (Messages)
Not a log — a **team channel**. Each director is a **character** (name, personality, color, a fun **SVG mascot avatar**) posting conversationally: *"🛠️ Ada · Platform — squashed a 500 on the portal path, all green; escorting the Acquisition goal, 3/5 milestones down 💪"*. **Two-way** (you reply / @-mention / ask "why?" → it answers, wired to dev-ask/spec-chat). **Per-director XP card** (specs shipped · bugs fixed · goals escorted · streak). **EOD recap** as a standup post: *"Shipped 8 specs · advanced 1 goal · fixed 2 bugs · approved 4 migrations."* Cast: 🛠️ Ada (Platform) · 🚀 Max (Growth) · 🎨 Iris (CMO) · 💬 June (CS) · 🧲 Theo (Retention) · 👑 You (CEO). *(Names/mascots reskinnable.)*

## The Platform/DevOps Director agent (the first live director)
- **Investigate → auto-approve** its inbox (error/db builds, box migrations): reads the *cause + proposed fix*, confirms sound + low-risk, approves; **never rubber-stamps**.
- **Escort approved goals through milestones** to completion (the chain-driving done by hand becomes its job — self-sequencing + merge + fold).
- **Watch the platform** ([[control-tower]]) + post human-readable updates to the board.
- **Loop-guard + CEO escalation:** tracks attempts/decisions per spec; a build that **repeatedly fails on the same error** → it *stops*, diagnoses "likely deeper issue," and **escalates to the CEO** to approve modifying the approach — never an infinite resubmit loop.

## The Platform team (workers reporting to the DevOps Director)
The autonomous workers the director supervises — each a real agent_jobs lane / agent. They show up in the **Workers tab + the org-chart view**, each with an avatar (all 20s) + a **precise responsibility list** on its profile page:
- **🟢 Rafa — Repair Agent:** triage every inbound error (Vercel/Supabase/loop), root-cause via logs, dismiss foreign/transient/already-fixed, author/propose fixes for real bugs, dedup repeat signals.
- **🔴 Remi — Regression Agent:** review regressions (a ✅ spec/feature that broke), dismiss false ones, **author the fix spec directly**, hand to the director to queue, loop-guard repeat-failing fixes. ([[../specs/regression-agent]])
- **🔵 Devi — DB Health Agent:** watch `pg_stat_statements` slow queries + table growth, EXPLAIN-diagnose, classify slow-per-call vs high-call-volume vs bloat, filter foreign/sunset, propose indexes/rewrites/vacuum. ([[../specs/db-health-agent]])
- **🟦 Cole — Coverage Register Agent:** detect Inngest fns served but missing from `MONITORED_LOOPS`, infer cadence/window/owner, propose registry entries or exemptions. ([[../specs/coverage-auto-register-agent]])
- **🟡 Vera — Verification (Spec-Test) Agent:** verify shipped specs actually hold (browser/db deep checks), catch false-✅ + drift, flag regressions to Remi, maintain the human-test queue.
- **🟠 Bo — Build Agent (the box):** claim build jobs, build specs on the box (Max), keep tsc clean, open PRs, fold-ready; multi-account failover.
- **🟢 Mira — Migration Agent:** apply/repair migrations, diagnose failed/blocked ones, reconcile migration-file drift vs the live DB.
- **⬜ Pax — PR-Resolve Agent:** resolve dirty/conflicted PRs (rebase, dedupe duplicate findings), keep the merge queue clean.
- **🟤 Fenn — Fold Agent:** fold shipped specs into the brain (lifecycle/table/inngest/library pages) + archive the spec files — keep the brain the source of truth.
- **🔷 Tao — Control Tower Monitor:** watch heartbeats/loops/errors, evaluate liveness windows, raise alerts on silent/failing loops, feed the error→repair pipeline.
- **🟣 Pia — Planner (Goal Decomposition):** decompose goals into milestone→spec trees with `blocked_by` deps, propose for approval, self-sequence the build order.

**The Agents sidebar includes an org-chart (employee) view** — CEO → Directors → Workers, every node clickable → its **profile detail page** (responsibilities; workers the most precise). See [[../specs/agents-hub-role-inboxes]] Phases 4–5.

## The leash (autonomy policy — the north-star guardrail)
**Auto-approves (no CEO):** error fixes · db indexes/health · additive/reversible migrations · **milestone progression of an already-approved goal** · platform-monitoring fixes.
**Escalates UP to CEO:** a **repeatedly-failing build** (deeper issue → modify the spec/approach) · **modifying or abandoning an approved goal** · **destructive/irreversible** actions (data-dropping migration, deleting infra) · **starting a NEW goal** (only the CEO greenlights goals). Mirrors the standing autonomy rule (autonomous for low-risk/reversible; gate high-stakes/irreversible).

## Foundations we already have (don't rebuild — supervise)
✅ [[../specs/repair-agent|repair agent]] · [[db-health-agent]] · [[coverage-auto-register-agent]] · the builder chain + auto-ship + fold · the box (multi-account failover) · [[control-tower]] · dev-ask/spec-chat (the "answer why" brain). The director **orchestrates these**, it doesn't replace them.

## Decomposition
- **M1 — Agents hub + role inboxes:** owner-only "Agents" sidebar (CEO · Directors · Workers, read from `functions/` + `goals/`); each role's inbox = Messages / Approval Requests / Daily Summaries + filters; CEO inbox live first. The reusable director persona + SVG-mascot design-system piece lands here. *(foundation — blocked_by [].)*
  - [[../specs/agents-hub-role-inboxes]] 🚧 — owner-only Agents hub ([[../dashboard/agents]]) reading the org chart from `functions/`+`goals/` via brain-roadmap, the three-tab inbox shell (Messages/Approval Requests/Daily Summaries, CEO inbox live first), + the reusable director-persona + SVG-mascot design system ([[../libraries/agent-personas]]). *(foundation — builds immediately)*
- **M2 — Approval routing engine:** route every approval to the first live supervisor up the org chart, else CEO; per-function `live + autonomous` flag; autonomous-approval **history logging**; migrate the existing scattered approval surfaces (Control Tower / spec cards / box) to emit into the routed inbox. *(blocked by M1.)*
  - [[../specs/approval-routing-engine]] ⏳ — the keystone: route approvals up to the first live+autonomous supervisor else CEO, per-function `live + autonomous` flag, an `approval_decisions` audit log, and migration of the scattered surfaces into the routed inbox. *(blocked by [[../specs/agents-hub-role-inboxes]])*
- **M3 — Gamified `#directors` board:** the Slack-style Messages experience — personas, SVG mascots, conversational posts, two-way reply (wired to dev-ask), per-director XP card, EOD recap. *(blocked by M1.)*
  - [[../specs/directors-board-gamified]] ✅ — the Slack-style Messages channel: persona/mascot conversational posts, two-way reply wired to dev-ask + spec-chat, per-director XP card ([[../libraries/director-xp]]), and the EOD recap standup ([[../libraries/director-recap]] · [[../inngest/director-recap-cron]]) extending the daily-report pattern. *(blocked by [[../specs/agents-hub-role-inboxes]])*
- **M4 — Platform/DevOps Director agent:** the first live director — investigate→auto-approve its routed inbox (within the leash), escort approved goals through milestones, loop-guard + CEO-escalation, post to the board + EOD recap. *(blocked by M2, M3.)*
  - [[../specs/platform-director-agent]] ✅ — the first live director (new `platform-director` agent_jobs kind): investigate→auto-approve within the leash, escort approved goals through milestones, loop-guard + CEO escalation, watch Control Tower + post to the board ([[../libraries/platform-director]] `postPlatformWatchUpdate`) + EOD recap; activation = flip Platform `live + autonomous` ([[../tables/function_autonomy]], `scripts/apply-platform-live-autonomous.ts`). Supervises the existing repair/db-health/coverage/builder-chain tools. *(blocked by [[../specs/approval-routing-engine]], [[../specs/directors-board-gamified]])*
- **M5 — Continuous loop + grading:** the standing cadence + the CEO's grade of the director's calls (was the auto-approval right? did the escorted goal land clean?) that trains it + tightens/loosens the leash. *(blocked by M4.)*
  - [[../specs/director-loop-grading]] ⏳ — the standing Platform-Director cadence + the CEO's 1–10 grade of its calls (auto-approval soundness + goal-escort), human-overridable + calibrated, feeding back as owner-confirmed leash widen/narrow. *(blocked by [[../specs/platform-director-agent]])*
- **M6 — Regression Agent (a DevOps worker):** reviews each regression (a ✅ spec/feature that broke) → **dismiss or author the fix spec directly** (skips "propose"); the DevOps Director queues the build within its leash. Does by-machine what the operator did by hand this session.
  - [[../specs/regression-agent]] ✅ (Phase 1) — detect (spec-test-✅-now-failing; tsc-CI / ship-correlated reuse the same enqueue) → review → dismiss-with-reasoning or author `docs/brain/specs/{slug}.md` directly → route to the inbox for the director to queue (pre-M4: CEO inbox); loop-guard escalates a repeatedly-failing fix to CEO. First concrete writer of [[../tables/director_activity]]. *(was blocked by [[../specs/approval-routing-engine]] Phase 1, now shipped)*
- **M7 — Worker coaching loop (the org learns):** the director **communicates with + improves its workers** — a repeated worker mistake → the director amends that worker's runtime **instruction set** (a learning), logs the director→worker message, and the worker improves next run. Guidance, not code; reversible; escalates a not-taking lesson to CEO.
  - [[../specs/worker-coaching-loop]] ⏳ — per-worker `worker_instructions` (versioned, loaded into the prompt) + `worker_coaching_log`; repeated-error detection off grades/`director_activity`; coach→amend→log→post-to-board→re-grade; routes a real code bug to Repair/Regression instead. *(blocked by [[../specs/platform-director-agent]])*
- **M8 — Board grooming (the director moves the board):** assess partially-shipped specs → build the needed-now next phase, or split future phases into their own planned cards (preserved, noted), so cards flow out of In-progress. Escalates the ambiguous.
  - [[../specs/board-grooming]] ⏳ *(blocked by [[../specs/platform-director-agent]])*

## Ownership & mirrors
Owner: [[../functions/platform]] (the Platform/DevOps director). Parent: reports to [[ceo-mode]]. Mirrors the [[storefront-optimizer]] goal (foundation → agent → grading) and is the **template every other director inherits** (Growth, CMO, CS, Retention each get the same inbox + board + autonomy pattern).
