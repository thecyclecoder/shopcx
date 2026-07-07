# libraries/sonnet-prompt-auto-review

Supervised auto-review loop for proposed conversation rules: a box-session agent dispatched by the builder worker, not a raw-API cron. Every proposal is reviewed by `kind='prompt-review'` (Wren, a persona in [[../functions/cs]]'s team), and each verdict is recorded to [[../tables/director_activity]] under CS for June (CS Director) to supervise and grade.

**File:** `src/lib/sonnet-prompt-auto-review.ts`

**Supervision:** [[../functions/cs]] owns conversation-rule quality. The prompt-review agent runs on the box lane ([[../recipes/build-box-setup]]), with every verdict recorded to [[../tables/director_activity]] (`director_function='cs'`), and the kind graded by the CS director's sweep ([[../libraries/agent-grader]] — June's gradeable kinds include `'prompt-review'`). Reasoning from each session is surfaced on the proposed-prompt review view ([[../dashboard/ai-analysis]]).

## Exports

### `loadReviewInputs` — async function

```ts
async function loadReviewInputs(proposal: SonnetPrompt)
  : Promise<ReviewInputs>
```

Assembles the review context for a proposal:
- Top-K similar approved prompts from `sonnet_prompts` (ranked by embedding distance)
- Active [[../tables/policies]] 
- Source-pattern tickets from [[../tables/daily_analysis_reports]] + [[../tables/ticket_analyses]]
- Voice docs from disk: `docs/brain/customer-voice.md`, `docs/brain/operational-rules.md`, `docs/brain/ui-conventions.md`

Used by `scripts/builder-worker.ts → runPromptReviewJob` to feed the Max session.

### `buildSystemPrompt` — function

```ts
function buildSystemPrompt(inputs: ReviewInputs): string
```

Returns the system prompt for the review session. Includes the rubric + role (Wren as a conversation-rule analyst in June's charge).

### `buildUserPrompt` — function

```ts
function buildUserPrompt(proposal: SonnetPrompt, inputs: ReviewInputs): string
```

Returns the user prompt for the review session. States the proposal + verification criteria + the need for a structured JSON verdict.

### `parseDecision` — function

```ts
function parseDecision(response: Message, proposal: SonnetPrompt): Decision
```

Parses the agent's JSON response into a typed `Decision` object: `{ decision: 'accept' | 'reject' | 'human_review' | 'delete', confidence: number, reasoning: string, issues: string[] }`.

### `applyDecision` — function

```ts
async function applyDecision(
  proposal: SonnetPrompt,
  decision: Decision,
  session: AgentSession
): Promise<void>
```

Writes the verdict to the database with safety guards. Always writes [[../tables/sonnet_prompt_decisions]] first (audit trail); if that succeeds, updates [[../tables/sonnet_prompts]] with `auto_decision`, `status`, `reviewed_at`, etc.

**Safety guards** (see [[../inngest/sonnet-prompt-auto-review]] for the full list):
- Confidence `< REJECT_FLOOR (0.55)` → downgrade to reject
- Accept with `REJECT_FLOOR ≤ confidence < ACCEPT_FLOOR (0.70)` → downgrade to reject
- Model returns `human_review` → override to reject (auto-review never queues to humans)
- Daily cap reached → downgrade excess accepts to rejects
- Model returns `delete` → rewrite to `supersede`

## Callers

- `scripts/builder-worker.ts → runPromptReviewJob` — the box worker claims each `kind='prompt-review'` job, loads review inputs, runs the Max session with `buildSystemPrompt`/`buildUserPrompt`, parses the JSON verdict, and calls `applyDecision` to write the outcome. Records to [[../tables/director_activity]] on completion (`actor`, `action_kind='reviewed_prompt'`, `spec_slug=proposal.id`, `reason`, `metadata: { decision, confidence, issues }`).

## Related

[[../inngest/sonnet-prompt-auto-review]] · [[../tables/sonnet_prompts]] · [[../tables/sonnet_prompt_decisions]] · [[../tables/director_activity]] · [[../functions/cs]] · [[../libraries/director-activity]] · [[../dashboard/ai-analysis]]

---

[[../README]] · [[../../CLAUDE]]
