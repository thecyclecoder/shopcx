# Box-session transparency — a live checklist + notes on every box session

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate — the autonomous box is supervisable (you can see what every agent is doing, live)
**Priority:** critical

## Problem

A box session is a black box. When ANY agent runs (`claude -p`) — Bo building, Ada grooming, Rafa repairing, Remi reviewing a regression, Vale reviewing a spec, Vault on a security pass — you see a status chip (`building…`) and, at the end, a `log_tail`. You can't see what it PLANNED to do, where it is, or why. That's the opposite of the north star (every autonomous tool surfaces its reasoning). The CEO asked: every box session should state its checklist up front, tick through it live, and show a plain-English note per step — mirrored on the box card — and the records should persist for later review.

## Model

This is a **helper attached to EVERY box session**, not one agent. Today ~12 near-identical `run*Claude` functions in `scripts/builder-worker.ts` each spawn `claude -p --output-format stream-json` separately. Funnel them through ONE shared streaming runner that:
1. Appends a shared instruction to every agent prompt: *"Maintain a TodoWrite checklist — state your plan as todos up front, mark each in_progress/completed as you go, and put a ONE-LINE plain-English note on each (what you're doing + why). It's shown live on your box card; keep it human-readable."*
2. PARSES the stream-json live for the agent's `TodoWrite` tool calls (the stream already carries them — it's `--output-format stream-json --verbose`), and writes the current checklist + the latest note to the running job's row, throttled (~every few seconds / on change).
3. The records PERSIST on the job row for later review.

## Phases

## Phase 1 — the shared streaming runner + DB
- Schema: `agent_jobs.session_checklist jsonb` (`[{step, status:'pending'|'in_progress'|'done', note}]`) + `agent_jobs.session_note text` (the single most-recent human note, for the compact chip). No migration risk — additive.
- Extract the duplicated `run*Claude` bodies into ONE `runBoxSession(prompt, sessionId, cwd, configDir, { jobId, kind, timeout, idleTimeout })` — same env/sandbox/stream-parse they share today — and route the existing runners through it (keep their per-kind timeouts). It parses each stream-json line: on an `assistant` event whose content includes a `TodoWrite` tool_use, extract the todos → upsert `session_checklist` + `session_note` on `jobId` (throttled; best-effort, never blocks the run).
- Append the shared TodoWrite instruction to every agent prompt (one place — the runner — so every kind gets it, no per-prompt edits).

## Phase 2 — surface it on the box card (un-black-box it)
- The build card ([[../dashboard/roadmap]] BuildButton) + the agents board ([[../dashboard/agents]]) render the live checklist for an ACTIVE job: each step with its pending/in_progress/done state + the latest note prominently (the "what's it doing RIGHT NOW" line). Replaces the opaque `building…` chip.
- Compact form on the card chip: the `session_note` (one line). Expand → the full checklist.

## Phase 3 — the session-review surface
- A session's preserved `session_checklist` + `session_note` (+ log_tail, verdict, grade) is viewable after the fact — per job, and rolled up per agent — so a human can review HOW an agent worked, not just its terminal status. Pairs with the grading loop (the grader can cite the checklist).

## Verification
- Start any build → its card shows a live checklist (plan stated up front), items flipping pending→in_progress→done, and a changing one-line note — for Bo AND for a director/repair/regression/spec-review session.
- After a session ends, its checklist + notes are still on the row, viewable for review.
- No agent kind is a black box: every `run*Claude` routes through `runBoxSession` and gets the checklist for free.
