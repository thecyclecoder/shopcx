# Migration-Fix — Plain Question + Inline Answer ✅

**Owner:** [[../functions/retention]] · **Parent:** extends [[migration-fix-agent]]. Found in use 2026-06-20: a human-needed migration (audit 7ad54096) showed a hard-to-read technical diagnosis and gave the owner no way to respond.

When the migration-fix agent can't safely auto-fix a migration, two problems today: (1) it dumps a **technical diagnosis** the owner has to decode, and (2) there's **no way to respond** — the job just completes "human-needed." Fix both: the agent asks **one plain, actionable question**, and the owner **types an answer right there** on `/dashboard/migrations`, which resumes the agent.

## Fix
- **Agent asks a simple question, not a diagnosis.** For a human-judgment case, the `migration-fix` skill stops emitting a wall of check-jargon and instead pauses on **`needs_input`** with **one plain-language, actionable question** (reusing the existing `agent_jobs.questions` `[{id, q}]` shape). Jargon-free, names the concrete choice, ideally with the specific values. Example: *"This customer's locked-in price is unclear — our records show **$39** and **$49** for their coffee. What should we bill per unit?"* — not *"pricing_preserved failed: engine subtotal ≠ pre_migration_charge ±2¢/line."*
- **Owner answers inline.** The migrations **FixPanel** renders a `needs_input` job's question prominently with a **text input + Send** (and a general free-text note box). Submit reuses **`POST /api/roadmap/answer`** (`{jobId, answers:[{id, q, answer}]}` → `queued_resume`); the box resumes with the answer and proposes a concrete gated fix (→ the existing **Approve & fix**) or applies it.
- **API passthrough.** `/api/migrations` (which already attaches the fix job's `status`/`pending_actions`/`diagnosis`) also returns the job's **`questions`** so the panel can render the prompt + input.
- **Truly out-of-system cases** (e.g. no card anywhere — the customer must add one) stay terminal, but with a **one-line plain instruction** ("Ask {customer} to add a card; this sub can't bill until then") + still allow a free-text note.

## Verification
- On `/dashboard/migrations`, a `failed` row whose migration-fix job is **`needs_input`** → the 🤖 panel shows label "needs your answer", the box's **single plain question** (e.g. "…records show $39 and $49…what should we bill per unit?"), a text input per question, an optional note box, and a **Send** button (owner only; a non-owner sees "Owner answer required.").
- On that panel, type an answer + **Send** → `POST /api/roadmap/answer` `{jobId, answers:[{id,q,answer}]}` returns 200, the job flips `needs_input → queued_resume`, the migration-fix lane re-claims it, the box re-diagnoses **with the answer** (resumed session), and the row comes back **`needs_approval`** with a concrete `price_reconcile`/`variant_backfill`/`appstle_cancel` proposal reflecting the answer + the existing **Approve & fix** button.
- Inspect the `needs_input` job's `questions` jsonb → it's `[{id,q}]` with a **plain** question (names the decision + the specific values), NOT a `pricing_preserved`/check-name jargon dump.
- `GET /api/migrations` → each at-risk row's joined `fix` object includes a `questions` array (populated only when the job is `needs_input`).
- An **out-of-system** failure (no billable card) → the job is terminal `human_needed`; the panel shows a **one-line plain instruction** ("Ask {customer} to add a card; this sub can't bill until then") with **no** buttons (no dead-end technical dump).
- `npx tsc --noEmit` clean.

## Phase 1 — needs_input question + FixPanel answer box ✅
- ✅ The `migration-fix` skill (`.claude/skills/migration-fix/SKILL.md`) + the worker's `migrationFixPrompt` (`scripts/builder-worker.ts`) split the human path: **human-JUDGMENT → `needs_input`** with ONE plain `questions [{id,q}]` (no check-jargon); **out-of-system → terminal `human_needed`** with a one-line plain instruction.
- ✅ `runMigrationFixJob` handles the new **answer-resume** path: when the owner answers (`queued_resume` with `answers` set, no approved/declined action), it re-runs the skill via `migrationFixAnswerPrompt` **resuming the same Max session** with the answer → `propose` → `needs_approval` (the existing Approve & fix flow). A fresh `needs_input` parse parks `questions` + flips the job `needs_input`.
- ✅ `/api/migrations` selects + returns the fix job's `questions` on each at-risk row's `fix` object.
- ✅ The migrations **FixPanel** (`src/app/dashboard/migrations/page.tsx`) renders a `needs_input` job's question(s) prominently + a text input per question + a free-text note + **Send** (owner-only), wired to `POST /api/roadmap/answer` (reused as-is — `answerRoadmapBuild` already gates on `needs_input` → `queued_resume`).
- Brain: [[migration-fix-agent]] + [[../dashboard/migrations]] + [[../libraries/migration-fix]]. Fold on ship.
