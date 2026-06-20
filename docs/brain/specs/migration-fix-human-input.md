# Migration-Fix — Plain Question + Inline Answer ⏳

**Owner:** [[../functions/retention]] · **Parent:** extends [[migration-fix-agent]]. Found in use 2026-06-20: a human-needed migration (audit 7ad54096) showed a hard-to-read technical diagnosis and gave the owner no way to respond.

When the migration-fix agent can't safely auto-fix a migration, two problems today: (1) it dumps a **technical diagnosis** the owner has to decode, and (2) there's **no way to respond** — the job just completes "human-needed." Fix both: the agent asks **one plain, actionable question**, and the owner **types an answer right there** on `/dashboard/migrations`, which resumes the agent.

## Fix
- **Agent asks a simple question, not a diagnosis.** For a human-judgment case, the `migration-fix` skill stops emitting a wall of check-jargon and instead pauses on **`needs_input`** with **one plain-language, actionable question** (reusing the existing `agent_jobs.questions` `[{id, q}]` shape). Jargon-free, names the concrete choice, ideally with the specific values. Example: *"This customer's locked-in price is unclear — our records show **$39** and **$49** for their coffee. What should we bill per unit?"* — not *"pricing_preserved failed: engine subtotal ≠ pre_migration_charge ±2¢/line."*
- **Owner answers inline.** The migrations **FixPanel** renders a `needs_input` job's question prominently with a **text input + Send** (and a general free-text note box). Submit reuses **`POST /api/roadmap/answer`** (`{jobId, answers:[{id, q, answer}]}` → `queued_resume`); the box resumes with the answer and proposes a concrete gated fix (→ the existing **Approve & fix**) or applies it.
- **API passthrough.** `/api/migrations` (which already attaches the fix job's `status`/`pending_actions`/`diagnosis`) also returns the job's **`questions`** so the panel can render the prompt + input.
- **Truly out-of-system cases** (e.g. no card anywhere — the customer must add one) stay terminal, but with a **one-line plain instruction** ("Ask {customer} to add a card; this sub can't bill until then") + still allow a free-text note.

## Verification
- A human-judgment failure → the FixPanel shows a **single plain question** + a text box. Type an answer + Send → the job flips to `queued_resume`, the box resumes, and it comes back with a concrete **Approve & fix** proposal reflecting the answer.
- No more raw `pricing_preserved`/check-name jargon in the owner-facing prompt — the question is human-readable and names the actual decision.
- An out-of-system case shows a one-line instruction (no dead-end technical dump).

## Phase 1 — needs_input question + FixPanel answer box ⏳
The `migration-fix` skill emits a plain `needs_input` question for human-judgment cases (+ plain terminal instruction for out-of-system ones); `/api/migrations` returns `questions`; the FixPanel renders the question + text input + Send wired to `/api/roadmap/answer`. Brain: [[migration-fix-agent]] + [[../dashboard/migrations]] + [[../libraries/migration-fix]]. Fold on ship.
