# AI learning — the self-improvement loop

How the AI agent gets better at customer service without Dylan approving every rule. Tickets feed the grader; the grader feeds the daily report; the report proposes rules; the auto-review either accepts, rejects, merges, supersedes, or sends to human review; accepted rules land in the orchestrator's system prompt; the orchestrator handles the next batch of tickets differently; loop closes.

This page traces the full pipeline end-to-end. Single source of truth for "how does the AI learn from past mistakes?"

> **Update 2026-06-03 — no human queue.** The auto-review is decisive. There is no "pending review" outcome — proposals are accepted, rejected, merged, superseded, or kept-as-proposed-for-revision. Low confidence is rejected (the pattern resurfaces if real); the model is instructed to decide rather than defer.

## Why this exists

For ~6 months, every proposed sonnet_prompt sat in a `status='proposed'` queue waiting for Dylan to review. The queue grew faster than it cleared. Two outcomes:

1. **Real wins didn't ship.** A clear rule the AI needed sat for a week before anyone applied it.
2. **Noise piled up.** Single-ticket one-shot proposals never got pruned and made the queue feel hopeless.

The auto-review introduces a deterministic + audited filter so the queue stays consumable. Phase 3 safety guards (REJECT_FLOOR, ACCEPT_FLOOR, supersede-not-delete, daily cap, per-workspace flag) keep the system reversible without ever queuing to a human.

See `docs/brain/specs/prompt-learning.md` for the original spec.

## Cast

| Surface | Where |
|---|---|
| Per-ticket grading | [[../inngest/ticket-analysis-cron]] every 30 min → [[../tables/ticket_analyses]] |
| Daily synthesis | [[../inngest/daily-analysis-report-cron]] at 11 UTC → [[../tables/daily_analysis_reports]] + proposes rows in [[../tables/sonnet_prompts]] |
| Auto-review | [[../inngest/sonnet-prompt-auto-review]] at 11 UTC → writes [[../tables/sonnet_prompt_decisions]] + mutates [[../tables/sonnet_prompts]] |
| Voice + ops + UI rules | [[../customer-voice]], [[../operational-rules]], [[../ui-conventions]] — read at decision time |
| Policies | [[../tables/policies]] — cross-referenced in decisions |
| Live orchestrator | [[../lifecycles/ai-multi-turn]] — reads approved+enabled prompts from [[../tables/sonnet_prompts]] every turn |
| Dashboards | `/dashboard/ai-analysis` Auto-decisions + Pending review tabs |
| Override surface | `POST /api/sonnet-prompts/{id}/override` |

## Phase 1 — grading

Every closed AI-handled ticket gets a 1-10 grade within 30 minutes of close. The grader is `src/lib/ticket-analyzer.ts` invoked by [[../inngest/ticket-analysis-cron]]. The output (`ticket_analyses` row) holds `score`, `summary`, `issues[]`, `action_items[]`.

The grade reflects whether the AI followed:
- the policies that applied,
- the active sonnet_prompts rules,
- the voice + operational + UI conventions.

A score below 6 is a flag. A pattern of low scores around the same issue type is a rule candidate.

## Phase 2 — daily synthesis

[[../inngest/daily-analysis-report-cron]] runs daily at 11 UTC. For each workspace with ≥1 analysis yesterday:

1. Load all `ticket_analyses` for the day.
2. Call Claude Opus with the analyses + existing sonnet_prompts titles + active policies in the system prompt.
3. Opus returns: `summary`, `themes`, `recommendations`, `proposed_sonnet_prompts`, `proposed_grader_prompts`.
4. For each `proposed_sonnet_prompts`, insert a row into [[../tables/sonnet_prompts]] with `status='proposed'`, `proposed_at=now()`, and (in the spec's Phase 1 schema) `source_pattern_id` pointing back to the daily report.
5. Persist the report itself in [[../tables/daily_analysis_reports]] including `proposed_sonnet_prompt_ids[]` and the full theme breakdown.

That's the upstream. Until this commit, the queue stopped here.

## Phase 3 — auto-review (NEW)

[[../inngest/sonnet-prompt-auto-review]] runs at 11 UTC (right after the daily-report-cron). For every workspace where `workspaces.sonnet_auto_review_enabled=true`:

1. Pull up to 50 proposals with `status='proposed' AND auto_decision IS NULL`.
2. For each, load:
   - Top-K similar approved prompts (keyword overlap; pgvector path stubbed for later).
   - Active policies for the workspace.
   - Source pattern from [[../tables/daily_analysis_reports]] → contributing tickets via [[../tables/ticket_analyses]].
   - Voice docs — read from disk at function init, cached + hashed for audit.
3. Call Claude Opus with a strict decision schema. Required output: `decision`, `confidence`, `reasoning`, `references[]`, optional `suggested_revisions` / `merge_target_id` / `supersede_target_id`.
4. Apply through the Phase 3 safety guards (next section).

### Decision values

| decision | what it means | what we do to the prompt |
|---|---|---|
| `accept` | Clean win | `status='approved'`, `enabled=true`. Subject to daily cap. |
| `reject` | Bad idea (violates voice rule, duplicates existing, single-shot) | `status='rejected'`, `enabled=false` |
| `merge` | Same intent as an existing rule | `merged_into_id` set, `status='rejected'` |
| `supersede` | Replaces an existing rule (better/clearer/scoped right) | New: `status='approved'`. Old: `enabled=false`, `status='archived'`, `superseded_by_id` → new |
| ~~`human_review`~~ | **Removed 2026-06-03.** No human queue. | The model can still emit it, but the safety layer downgrades to `reject`. See "No human queue" below. |
| `revise` | Direction is right, wording isn't | `status='proposed'`, `suggested_revisions` written to the audit row |

## Phase 3.5 — safety guards (non-negotiable)

In `applyDecision()` (`src/lib/sonnet-prompt-auto-review.ts`):

- **REJECT_FLOOR = 0.55.** Any `confidence < 0.55` is downgraded to `reject` (dropped). The pattern will resurface with more evidence if it's real.
- **ACCEPT_FLOOR = 0.70.** An `accept` with confidence in [0.55, 0.70) gets downgraded to `reject`. Tentative accepts are not accepts — they're rejects we're being honest about.
- **No human queue.** If the model emits `human_review`, we override it to `reject`. The system is designed to be decisive; a backlog of "Dylan please look at this" is not a feature. The reasoning is preserved in the audit row so the model's hesitation is still visible.
- **Daily auto-approval cap.** Default 10 `accept` decisions per workspace per day. Excess get rejected, not queued.
- **`delete` is rewritten to `supersede`.** The model can't delete an approved prompt — supersede is the only allowed replacement path. Old row stays in place (`enabled=false`, `status='archived`).
- **Audit BEFORE apply.** [[../tables/sonnet_prompt_decisions]] insert happens first; only on success do we mutate [[../tables/sonnet_prompts]]. If the audit insert fails, the prompt is untouched.
- **Per-workspace enable flag.** `workspaces.sonnet_auto_review_enabled` (default `false`). Cron skips workspaces with it off.

A safety test (`scripts/test-prompt-auto-review-safety.ts`) verifies the never-delete + audit-first invariants against the live DB.

## Phase 4 — orchestrator picks up the rule

The orchestrator ([[../lifecycles/ai-multi-turn]]) loads `status='approved' AND enabled=true` rows from [[../tables/sonnet_prompts]] at every turn. Approved rules flow into the system prompt within the cache window. The next inbound message that triggers the rule gets handled differently.

## Phase 5 — human override

`/dashboard/ai-analysis` has one tab:

- **Auto-decisions** — last 50 decisions, color-coded badges, confidence bar, model reasoning, references with hover-why, override buttons (Accept manually / Reject manually / Revert to proposed).

There is no "Pending review" tab — the cron never queues to a human. If Dylan disagrees with a rejection, he reverts it from the Auto-decisions row.

Every override writes a NEW row in [[../tables/sonnet_prompt_decisions]] with `source='manual_override'`, `performed_by=user.id`, `confidence=1.0`. Append-only: the prior auto-decision history stays intact.

## How the loop closes

```
                    ┌──────────────────────────────────────┐
                    │  Live customer message               │
                    │  → orchestrator reads approved        │
                    │    sonnet_prompts (incl. new one)    │
                    │  → handles differently               │
                    └─────────────────┬────────────────────┘
                                      │
                                      ▼
                    ┌──────────────────────────────────────┐
                    │  ticket-analysis-cron grades         │
                    │  the response into ticket_analyses   │
                    └─────────────────┬────────────────────┘
                                      │
                                      ▼
                    ┌──────────────────────────────────────┐
                    │  daily-analysis-report-cron          │
                    │  synthesizes themes + proposes        │
                    │  new sonnet_prompts                  │
                    └─────────────────┬────────────────────┘
                                      │
                                      ▼
                    ┌──────────────────────────────────────┐
                    │  sonnet-prompt-auto-review           │
                    │  → accept / reject / merge /          │
                    │    supersede / revise                │
                    │    (Phase 3 guards; no human queue)  │
                    └─────────────────┬────────────────────┘
                                      │
                                      ▼
                              applied rule ─┐
                                            │
            ◀───────── loop tightens ───────┘
```

The faster this loop runs, the faster the AI converges on workspace-specific voice + policy alignment. Phase 3 safety + Phase 4 visibility keep it from running off a cliff.

## What this loop does NOT do

- It does **not** invent voice rules. The voice docs in `docs/brain/customer-voice.md` etc. are still hand-authored. The auto-reviewer references them; it doesn't propose changes to them.
- It does **not** edit policies. [[../tables/policies]] changes go through admin UI + a separate review process.
- It does **not** retroactively re-grade old tickets. Each daily report grades that day's tickets; the auto-reviewer evaluates that day's proposals.
- It does **not** affect grader_prompts. Those are handled separately in the same daily report but the auto-reviewer in scope here is only for the customer-facing `sonnet_prompts`.

## Files touched

| File | Purpose |
|---|---|
| `supabase/migrations/20260604000000_sonnet_prompt_auto_review.sql` | Schema: columns on sonnet_prompts + new sonnet_prompt_decisions + workspace flags |
| `scripts/apply-sonnet-prompt-auto-review-migration.ts` | One-shot apply |
| `src/lib/sonnet-prompt-auto-review.ts` | All the logic: loadReviewInputs, callOpusReview, parseDecision, applyDecision, reviewSingleProposal, reviewWorkspace |
| `src/lib/inngest/sonnet-prompt-auto-review.ts` | Inngest cron wrapper |
| `src/app/api/inngest/route.ts` | Registers `sonnetPromptAutoReviewCron` |
| `src/app/api/workspaces/[id]/sonnet-prompt-decisions/route.ts` | GET feed for dashboard tabs |
| `src/app/api/sonnet-prompts/[id]/override/route.ts` | POST manual override |
| `src/app/dashboard/ai-analysis/page.tsx` | Tab-style page with Auto-decisions + Pending review |
| `scripts/test-prompt-auto-review-safety.ts` | 4 invariant tests run against the live DB |
| `src/lib/ai-models.ts` (constants) · `src/lib/ai-usage.ts` (cost accounting) | Existing helpers used by the review logic |
| `src/lib/daily-analysis-report.ts` · `src/lib/inngest/daily-analysis-report-cron.ts` · `src/lib/inngest/ticket-analysis-cron.ts` | Upstream proposal pipeline (unchanged) |

## Status / open work

**Shipped:** End-to-end loop is wired. Per-ticket grading (every 30 min) → daily synthesis (11 UTC) → Claude Opus auto-review with full safety guards (11 UTC) → audit-logged decisions → orchestrator picks up approved rules on the next turn. Dashboard tabs + override buttons functional. Safety test verifies all four invariants (no-delete, confidence floor, daily cap, audit-first).

**Known gaps / not yet shipped:**
- No workspace has `sonnet_auto_review_enabled=true` yet. Manual flip per-workspace once Dylan reviews the first batch on /dashboard/ai-analysis.
- Similar-prompt retrieval uses keyword-overlap not pgvector. `sonnet_prompts.embedding` column doesn't exist yet — see `src/lib/sonnet-prompt-auto-review.ts:loadReviewInputs` for the stub.
- `grader_prompts` get proposed by the same daily report but are NOT yet auto-reviewed — separate spec needed if we want symmetry there.
- The `delete → supersede` rewrite is a hard-coded guard; the model can't know about it from its prompt. If we ever want the model to recommend `supersede` directly, the system prompt should be updated.
- Override surface in /dashboard/ai-analysis is functional but lacks bulk actions (accept-all / reject-all-low-confidence). Add if the queue grows beyond ~50 pending.

**Recent activity:**
- `91fea5a3` Prompt learning — auto-review of proposed sonnet_prompts (spec shipped)
- 2026-06-03 — Removed `human_review` as a cron outcome. Replaced single `CONFIDENCE_FLOOR=0.75` with two-tier `REJECT_FLOOR=0.55` + `ACCEPT_FLOOR=0.70`. Updated Opus system prompt to demand decisiveness. First live run: 20 accept / 10 reject / 4 merge / 1 supersede / 0 human_review.

**Open questions:**
- What's the right per-workspace daily cap for a workspace with ~1000 tickets/day? 10 may be too low or too high — tune after first month of live decisions.
- Should `revise` decisions auto-create a NEW proposal with the suggested revisions applied, or leave that to a human? Currently stays as `status='proposed'` with the suggestion on the audit row.
- Should we tighten REJECT_FLOOR / ACCEPT_FLOOR after we see a few weeks of decisions? Reject rate too high → loosen; accept rate too aggressive → raise ACCEPT_FLOOR.

## Related

[[ai-multi-turn]] · [[ticket-lifecycle]] · [[research-and-heal]] · [[../tables/sonnet_prompts]] · [[../tables/sonnet_prompt_decisions]] · [[../tables/ticket_analyses]] · [[../tables/daily_analysis_reports]] · [[../tables/policies]] · [[../inngest/ticket-analysis-cron]] · [[../inngest/daily-analysis-report-cron]] · [[../inngest/sonnet-prompt-auto-review]] · [[../customer-voice]] · [[../operational-rules]]
