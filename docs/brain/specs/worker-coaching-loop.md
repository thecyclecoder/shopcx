# Worker coaching loop — the director teaches its workers ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/devops-director]] (M7 — the org learns)
**Blocked-by:** [[platform-director-agent]]

The [[platform-director-agent|DevOps Director]] doesn't just queue + grade — it **communicates with its workers and improves them**. When a worker makes a **repeated mistake**, the director **amends that worker's instruction set** (a *learning*), the communication is **logged**, and the worker picks up the new guidance on its next run. Over time the workers get sharper without a human (or a code change) in the loop. This is what the operator did by hand this session (the [[db-health-agent-accuracy|DB-Health accuracy upgrade]] — fixing mis-classification); this makes it a **standing capability** the director owns.

## The mechanism (guidance, not code)
- **Workers load a mutable instruction set at runtime.** Each worker (an `agent_jobs` kind / agent) reads a per-worker **`worker_instructions`** store (versioned guidance) *appended to its base prompt* every run — a per-worker learnings memory (mirrors the [[../tables/grader_prompts]] proposed→approved calibration pattern + the [[../specs/storefront-lever-importance-memory|lever-importance memory]]). Coaching = a **data write**, not a deploy.
- **Detect the repeated mistake.** From the [[director-loop-grading|grades]] + [[../tables/director_activity]] outcomes + repeat-failure signals, the director spots a worker making the *same class* of error N times (e.g. Rafa repeatedly dismissing our-own-API 5xx as "foreign"; Devi repeatedly mislabeling a hot-but-fast query as "bloat").
- **Coach — amend the instruction set.** The director writes a new guardrail/learning to that worker's `worker_instructions` ("when you see X, do Y instead — because Z"), with the triggering pattern + reasoning.
- **Log the communication.** A **`worker_coaching_log`** entry (director → worker, timestamped, old→new instruction diff, the triggering pattern, the grade that prompted it) — surfaced on the worker's **profile page** (a "coaching history") and as a board post (*"🛠️ Ada coached 🟢 Rafa: stop dismissing our-own-API 5xx as foreign — they're real"*). It's a real, visible message, per the goal's communication model.
- **Worker improves.** Next run it loads the amended instructions → the error class drops; the director **measures** the post-coaching grade to confirm the learning stuck (and revises if not).

## Supervisable (north-star) + guardrails
- **Coaching is reversible guidance** (low-risk) → the director does it within its leash; every amendment is versioned + revertible.
- **Guidance gap vs code bug.** If the repeated error is actually a *code* defect (not a guidance gap), the director routes it to [[../specs/repair-agent|Repair]] / [[regression-agent|Regression]] (a fix spec), **not** an instruction tweak — coaching ≠ patching bugs.
- **Coaching that doesn't take.** If a worker keeps erring *after* N coaching attempts on the same class → **escalate to CEO** (the instruction approach isn't working — maybe a deeper redesign), per the loop-guard.
- **The worker never edits its own instructions** — only its director coaches it; the director answers to the CEO. (CEO → Director → worker.)

## Phase 1 — worker instruction store + repeated-error detection + coach + log ⏳
`worker_instructions` (per-worker versioned guidance, loaded into the worker's prompt at runtime) + `worker_coaching_log`; the director's repeated-error detector (off grades + `director_activity`); the coach action (amend instructions, log the director→worker message, post to the board); the guidance-gap-vs-code-bug router; post-coaching grade re-check. Brain: [[../goals/devops-director]] · [[platform-director-agent]] · [[director-loop-grading]] · [[../tables/grader_prompts]] · [[regression-agent]] · [[../specs/repair-agent]].

## Verification
- A worker that makes the same class of mistake ≥N times → the director writes a `worker_instructions` amendment (a learning) + a `worker_coaching_log` row (director→worker, with the diff + pattern); a board post appears.
- The worker's **next run loads the amended instructions** (the guidance is in its prompt) and the error class measurably drops; the director's post-coaching grade re-check confirms it.
- The worker's **profile page** shows its coaching history (the director's messages to it over time).
- A repeated error that's actually a **code bug** → routed to Repair/Regression as a fix spec, NOT an instruction tweak.
- Coaching that fails to fix the class after N attempts → **escalates to CEO** (not infinite re-coaching).
- Negative: a worker cannot edit its own `worker_instructions` — only its director (verify the write path is director-gated).
