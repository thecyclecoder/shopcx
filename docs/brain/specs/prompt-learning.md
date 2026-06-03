# Prompt Learning — auto-review of proposed sonnet_prompts

Build a nightly cron that reviews proposed sonnet_prompts and auto-decides accept / reject / merge / supersede / human-review by comparing each proposal against existing rules, policies, voice docs, and the source tickets. Goal: the AI agent improves itself without requiring Dylan to approve every suggestion. Hard rule per CLAUDE.md: anything new lands a brain page in the same PR.

## Phase 1 — schema

Add to `sonnet_prompts`:
- `auto_decision` text — `accept` / `reject` / `merge` / `supersede` / `human_review` / `revise`
- `auto_decision_at` timestamptz
- `auto_decision_reason` text
- `auto_decision_model` text
- `auto_decision_confidence` float (0..1)
- `superseded_by_id` uuid (FK → sonnet_prompts.id)
- `merged_into_id` uuid (FK → sonnet_prompts.id)
- `source_pattern_id` uuid (FK → daily_analysis_reports.id)

Create `sonnet_prompt_decisions` — one row per AI decision with full input/output JSONB: the prompts compared, policies referenced, source tickets, decision rationale, model + tokens. Append-only audit log. Workspace-scoped + RLS.

Migration + apply-script in `scripts/`.

## Phase 2 — review cron

New Inngest cron `sonnet-prompt-auto-review`, cron expression `0 11 * * *` (6 AM Central daily), `concurrency: [{ limit: 1 }]`.

For every `sonnet_prompts` row with `status='proposed' AND auto_decision IS NULL AND workspace.sonnet_auto_review_enabled=true`:

1. Load similar approved prompts in the workspace (pgvector cosine similarity on content if `sonnet_prompts.embedding` exists, else fuzzy text match top-K).
2. Load active policies relevant to the proposal's topic — `policies` rows with overlapping keywords or topic tags.
3. Load the source pattern from `daily_analysis_reports` + the 3-5 contributing tickets via `ticket_analyses`.
4. Read `docs/brain/customer-voice.md` + `operational-rules.md` + `ui-conventions.md` from disk at function init time (cached for the cron run).
5. Call Claude Opus with the decision schema. Required outputs:
   - `decision` — one of the six values above
   - `confidence` — 0..1
   - `reasoning` — one paragraph
   - `references` — array of `{type: 'prompt'|'policy'|'ticket'|'voice_rule', id, why}`
   - `suggested_revisions` — string, only when `decision='revise'`
   - `merge_target_id` / `supersede_target_id` — only when applicable
6. Apply with the Phase 3 safety guards.

## Phase 3 — safety

Non-negotiable invariants:

- **Never delete an approved prompt.** Supersede sets `enabled=false` + `superseded_by_id` on the old. Always reversible.
- **Confidence floor 0.75.** Any decision with `confidence < 0.75` is forced to `human_review` regardless of the model's recommendation. Status stays `proposed`; tag `flagged_for_review` added.
- **Daily auto-approval cap.** Max 10 `accept` decisions per workspace per day (configurable on workspace). Excess proposals queue for the next day.
- **Audit BEFORE apply.** Write the `sonnet_prompt_decisions` row first; only on successful insert do we mutate `sonnet_prompts`. Wrap in a transaction.
- **Per-workspace enable flag.** `workspaces.sonnet_auto_review_enabled` (boolean, default `false`). Cron skips workspaces with it off. Flip per-workspace when ready.
- **Test coverage.** Add a test (or runnable smoke script) that submits a proposal aiming to delete an existing approved rule and verifies the cron rejects it / converts to supersede.

No shadow mode. Decisions are LIVE on enabled workspaces.

## Phase 4 — dashboard

Extend `/dashboard/ai-analysis` with a new top-level "Auto-decisions" tab showing the last 50 decisions per workspace:

- Decision badge (color-coded — green accept, red reject, blue merge/supersede, amber human_review, zinc revise)
- Confidence bar
- Original proposal text + agent's revision (if applicable)
- References list with click-through to each cited prompt/policy/ticket
- Reasoning paragraph
- Override buttons: **Revert to proposed** / **Accept manually** / **Reject manually** — these flip `auto_decision` to null and re-stamp `status` accordingly, with a `sonnet_prompt_decisions` row recording the human override.

Second sub-view: **Pending review** — the queue of proposals where the AI returned `human_review` (sorted by confidence ascending — least-confident first).

## Phase 5 — brain docs

Per CLAUDE.md hard rule:

- Update `docs/brain/lifecycles/ai-analysis.md` — add a new Phase 4.5 "Auto-review" between the existing "Propose" and "Human review" phases. Include the safety invariants.
- New `docs/brain/lifecycles/ai-learning.md` — trace the full self-improvement loop end-to-end: tickets → grader → patterns → proposals → auto-review → applied rules → orchestrator → tickets. Show how the loop closes.
- Update `docs/brain/tables/sonnet_prompts.md` with the new columns + the auto_decision lifecycle.
- New `docs/brain/tables/sonnet_prompt_decisions.md`.
- Update `docs/brain/orchestrator-tools.md` if any new tool surfaces.
- README.md folder + page counts.

## Phase 6 — bootstrap

The ai-nightly-analysis cron has been paused since 2026-04-28. Resume it — the auto-review cron has nothing to chew on without upstream proposals flowing. See memory `project_ai_analysis_apr28` for the specific open items (Ivan, Faye, Gail; jo:* tag conflict; Sarah's $13.96). Don't backfill the paused window — start fresh from the resume date so the auto-review system sees current patterns, not stale ones.

## Completion criteria

- Schema applied via supabase migration + apply script.
- Cron registered in `src/app/api/inngest/route.ts`.
- `sonnet_prompt_decisions` has at least one test row (from the safety test).
- Dashboard tab + override buttons functional.
- Safety test passes (attempt-to-delete-approved-rule → rejected or supersede).
- Brain pages updated per Phase 5.
- ai-nightly-analysis cron resumed.
- No workspace has `sonnet_auto_review_enabled=true` in this goal — that's a separate flip after Dylan reviews the first auto-decisions on the dashboard.
```
