# libraries/sonnet-prompts-table

The typed read/write surface for `public.sonnet_prompts` ([[../tables/sonnet_prompts]]) — every proposal insert, review decision, supersede archive, and human override on the table routes through this SDK, never a raw `.from('sonnet_prompts').insert()/.update()` in agent code.

**File:** `src/lib/sonnet-prompts-table.ts`

## Why this exists

Phase 1 of [[../specs/sonnet-prompts-sdk-for-review-agent-db-access]]. Before the SDK, six code paths (auto-review's `applyDecision`, the /override route, the daily-analysis report, the playbook compiler, the ticket-improve action, the escalation-triage triage-todo materializer, and the CS-director digest reply) each wrote review-state columns on their own — one branch would set four of the five `auto_decision_*` columns while a sibling branch set a fifth, or a supersede archive would land the OLD row without the NEW row's decision transitioning. Consolidating those writes here means one caller can never drift on which columns a verdict touches.

Mirrors [[ticket-analyses-table]] + [[specs-table]] ([[../operational-rules]] § Database is the spec) — the same one-writer-per-decision pattern already sealed for `public.ticket_analyses` and the PM tables.

## Exports

- **`proposePrompt(admin, input)`** → `{ id, error }` — insert one PROPOSAL row (`status='proposed'`, `enabled=false`, `proposed_at=now`, `sort_order=200` default). The ONE writer every proposer routes through: the daily-analysis report ([[daily-analysis-report]]), the playbook compiler ([[playbook-compiler]]), the ticket-improve action dispatcher ([[improve-actions]]), the escalation-triage triage-todo materializer ([[agent-todos/triage]]), and the CS-director digest reply ([[cs-director-digest-reply]]). Accepts optional `derivedFromTicketId` (ticket-source proposals) and `sourcePatternId` (daily-report source pattern).
- **`applyReviewDecision(admin, input)`** → `{ ok, error }` — apply a review verdict to a proposed prompt. The ONE writer that stamps ALL FIVE `auto_decision_*` columns + `status` + `enabled` + `reviewed_at` in one call. Called by [[sonnet-prompt-auto-review]] `applyDecision` after safety gates have resolved the FINAL decision. Decision → row shape mirrors the auto-decision lifecycle in [[../tables/sonnet_prompts]] § Auto-decision lifecycle. Compare-and-set on `(workspace_id, id)`; `.select("id")` asserts exactly one row transitioned so a concurrent manual override lands as `rows=0` rather than a silent double-write. Guards missing merge/supersede targets with a typed error before touching the row.
- **`archiveSupersededPrompt(admin, {workspaceId, oldPromptId, newPromptId})`** → `{ ok, error }` — archive the OLD row on a supersede verdict. Sets `superseded_by_id`, `enabled=false`, `status='archived'`. Never deletes — a supersede is REVERSIBLE (the archived row is preserved). Called by [[sonnet-prompt-auto-review]] `applyDecision` right after `applyReviewDecision` on the NEW proposal lands. Compare-and-set on `(workspace_id, id)`.
- **`applyManualOverride(admin, {workspaceId, promptId, action, actor, reasonPrefix})`** → `{ ok, error }` — human override from `/api/sonnet-prompts/[id]/override`. `accept` → status=approved + enabled=true + auto_decision='accept' + reviewed_by; `reject` → status=rejected + enabled=false + auto_decision='reject' + reviewed_by; `revert` → status=proposed + enabled=true + auto_decision=NULL + reviewed_at cleared. `auto_decision_model` is always `'manual_override'` so the /dashboard/ai-analysis Auto-decisions tab distinguishes cron verdicts from human overrides.
- **`getProposal(admin, workspaceId, proposalId, opts?)`** → `{ row, error }` — fetch ONE proposed prompt by id, workspace-scoped. Used by the box worker's `runPromptReviewJob` pre-flight check ([[../inngest/sonnet-prompt-auto-review]] flow) to bail cleanly when a proposal was already decided.
- **`listProposed(admin, workspaceId, opts?)`** → `{ rows, error }` — list `status='proposed' AND auto_decision IS NULL` prompts, oldest first, capped by opts. Matches the shape the Inngest cron reads today; exposed for a future migration to drop the raw select.

All writers route through `createAdminClient()` (service-role). Reason strings are clipped to 2000 chars inside the SDK so callers cannot silently drift.

**Raw sonnet_prompts writes are CI-forbidden outside this SDK.** `scripts/_check-sonnet-prompts-sdk-compliance.ts` (chained into `predeploy`) fails the build on any `.from('sonnet_prompts').update()/.insert()/.upsert()/.delete()` in `scripts/builder-worker.ts`, `src/lib/**`, or `src/app/**` that isn't in this SDK and isn't on its `SANCTIONED_RAW_WRITES` allow-list. The sanctioned exceptions cover the workspace-admin CRUD lane (Settings → AI → Prompts) + the daily-analysis regen cleanup — every other write flows through a narrow SDK surface.

## Design notes

- **Every verdict writes the full column set.** `applyReviewDecision` sets `auto_decision`, `auto_decision_at`, `auto_decision_reason`, `auto_decision_model`, `auto_decision_confidence`, `status`, and `reviewed_at` in one UPDATE — so no verdict can land half-stamped, and no future caller can drift by writing four of the five and a fifth from elsewhere.
- **`enabled` is intentionally NOT stamped on `accept` / `supersede`.** Preserves the pre-SDK auto-review behavior: an accepted proposal lands with `status='approved'` but `enabled=false` (inherited from the proposal insert), so an admin flips it live from /dashboard/settings/ai/prompts. The [[../tables/sonnet_prompts]] brain page's lifecycle diagram shows `enabled=true` on accept — that's an older doc/code drift the Phase 1 migration explicitly does NOT fix (would be a behavior change out of scope for a routing pass). A follow-up spec can align them.
- **Compare-and-set on workspace_id + id.** Every writer guards on `workspace_id` so a cross-workspace id sneak (an admin route's promptId route param) can never flip a foreign row. `.select("id")` asserts exactly one row transitioned; a race with a concurrent manual override lands as `rows=0` rather than a silent double-write.
- **Audit-first ordering stays with the caller.** The SDK writes only the prompt row — the [[../tables/sonnet_prompt_decisions]] audit-first invariant ([[sonnet-prompt-auto-review]] Phase 3) lives in the caller (the box worker's `applyDecision` inserts the audit row BEFORE calling `applyReviewDecision`; the /override route does the same). This keeps the SDK small and the audit ledger the caller's explicit responsibility.
- **Supersede archives, never deletes.** `archiveSupersededPrompt` preserves the old row with `status='archived'` — the /dashboard/ai-analysis view can render the supersede chain and an admin can re-enable the archived row if the new proposal turns out to be worse. This mirrors the "supersede-not-delete" hard rule in [[sonnet-prompt-auto-review]].
- **Confidence is the RAW value.** `auto_decision_confidence` stores the model's raw confidence (0..1) unchanged, NOT the safety-downgraded value. The floor gates + downgrades live in `applyDecision`'s safety logic ([[sonnet-prompt-auto-review]] § applyDecision). The SDK writes what the caller gives it.

## Callers

- **[[sonnet-prompt-auto-review]]** `applyDecision` — the box's cron review path. Calls `applyReviewDecision` with the FINAL decision (post-safety-gate) + `archiveSupersededPrompt` on a supersede verdict.
- **`src/app/api/sonnet-prompts/[id]/override/route.ts`** — the human override lane. Calls `applyManualOverride` for accept/reject/revert.
- **[[daily-analysis-report]]** — the daily Opus-drafted report. Calls `proposePrompt` for each proposed rule the report surfaces.
- **[[playbook-compiler]]** — the weekly resolution-pattern miner. Calls `proposePrompt` for each cluster it drafts.
- **[[improve-actions]]** `propose_sonnet_prompt` — the ticket-improve action dispatcher. Calls `proposePrompt` when the improve tab (or its Opus loop) authors a rule.
- **[[agent-todos/triage]]** `handEscalationSolverToWorker` — the escalation-triage materializer. Calls `proposePrompt` when a solver→skeptic quorum proposes a `sonnet_prompt`.
- **[[cs-director-digest-reply]]** `addRuleFromStoryline` — the CS-director digest bidirectional reply. Calls `proposePrompt` when the founder replies with "add rule" on a storyline.

## Related

[[../tables/sonnet_prompts]] · [[../tables/sonnet_prompt_decisions]] · [[sonnet-prompt-auto-review]] · [[../inngest/sonnet-prompt-auto-review]] · [[../specs/sonnet-prompts-sdk-for-review-agent-db-access]] · [[../specs/prompt-auto-review-becomes-box-agent-under-june]] · [[ticket-analyses-table]] · [[specs-table]] · [[../operational-rules]]
