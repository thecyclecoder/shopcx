# libraries/cs-director-author-spec-failure-card

The **pure builder** for the CEO inbox card (dashboard_notification) that Phase 2 of [[../specs/june-authored-specs-carry-machine-runnable-checks]] mints when the CS Director (💬 June) returns an `author_spec` verdict whose spec write FAILED.

**File:** `src/lib/cs-director-author-spec-failure-card.ts`

## What it does

Composes the `agent_approval_request` dashboard_notification that reaches the CEO inbox when a June `author_spec` verdict cannot land a spec. Before this shipped, `handleAuthorSpec`'s failure branches (`spec_seed_missing_*` · `ticket_id_unresolved` · `author_spec_write_returned_false` · `author_spec_threw` · `handler_threw`) parked the agent_job `needs_attention` — the designed job-level fail-safe — but no human ever saw it: the ticket was left open, de-escalated, with no CEO card (Yvonne Carreon: 2.6 days sitting in that limbo before the founder worked the queue by hand). A fail-safe nobody can see is not a fail-safe. Phase 1 removed today's dominant cause (`buildAuthorSpecInput` now emits typed machine-runnable checks so the SDK stops throwing `MissingMachineCheckError` on every call); THIS card makes the NEXT unexpected author-spec failure visible to the founder immediately instead of silent.

The card carries three labeled sections:
- **Intended spec:** the `{slug} — {title}` June named on the verdict's `spec_seed`. When the seed itself is missing/malformed (the `spec_seed_missing_*` branch), the line explicitly names that so the founder is not misled that the seed exists but is unreadable.
- **Diagnosis:** June's 2-4 sentence finding (the concrete product gap she identified) — normalized to "(no reasoning recorded)" when empty so the card never has a blank line.
- **Failure ({branch}):** the machine-readable failure branch + the human-readable error line when `handleAuthorSpec` set one. The `{branch}` name (e.g. `author_spec_threw` / `author_spec_write_returned_false`) is what a grader / audit reader keys off to distinguish a genuinely blocked write from a bug in the author path itself.

The structure mirrors [[cs-director-escalate-founder-card]] on shape + surface conventions so the CEO reads both classes of escalation the same way.

## Exports

- **`buildAuthorSpecFailureCard(input: AuthorSpecFailureCardInput): AuthorSpecFailureCardRow`** — pure function composing the dashboard_notifications row (title/body/link/metadata). Reads-only from the input; the caller is responsible for the write.
- **`summarizeIntendedSpec(seed?: Record<string, unknown>): string`** — helper that renders the intended spec as one line (`{slug} — {title}` / `{slug}` / `{title}` / "(none — the spec_seed itself was missing/malformed on the verdict)" / "(none — the spec_seed carried no slug/title)"). Deterministic; unit-tested exhaustively.
- **`AuthorSpecFailureCardInput`** — interface for the input shape (ticketId, reasoning, jobId, optional triageRunId, failureReason, optional failureError, optional specSeed).
- **`AuthorSpecFailureCardRow`** — interface for the returned dashboard_notifications shape (title/body/link/metadata). Metadata carries `failure_reason` + `failure_error` + `spec_seed` verbatim so a downstream approver / bounce-back handler can pick them up without re-parsing the body.

## How it's used

**Caller:** `scripts/builder-worker.ts` `runCsDirectorCallJob` — after `applyBoxCsDirectorCall` returns, the runner checks `verdict.decision === 'author_spec' && authorOutcomeOk === false` and, if so, calls `buildAuthorSpecFailureCard(...)` and passes the result to a `dashboard_notifications` insert. Same single-writer contract [[cs-director-escalate-founder-card]] respects — the RUNNER is the sole writer of the card; the handler in `src/lib/cs-director.ts` NEVER inserts a `dashboard_notifications` row from inside itself.

The runner also stamps the workspace owner on the ticket via [[cs-director-ticket-transition]] so the failed author_spec transition returns `keep_escalated_needs_attention` with `escalated_to = ceoUserId` — the ticket lands in the founder-escalated view alongside every other CEO-owned escalation, matching the card.

The card metadata includes:
- `routed_to_function: 'ceo'` — routes to the CEO inbox
- `escalation_kind: 'cs_director_author_spec_failed'` — identifies the card class (distinct from `cs_director_escalate_founder`)
- `escalation_reason` — `author_spec FAILED ({branch}): {reasoning}` (trimmed, verbatim from June)
- `failure_reason` — the machine-readable branch (grep-able)
- `failure_error` — the human-readable error line from `handleAuthorSpec` when set, null-safe
- `spec_seed` — verbatim, so a downstream approver / bounce-back handler can pick it up structurally
- `agent_job_id` — cs-director-call job ID so the approvals-feed enrichment can join to the audit trail

## Gotchas

- **Pure / test-friendly.** The function takes no DB or runtime context — `runCsDirectorCallJob` handles the `dashboard_notifications` write, and unit tests (`cs-director-author-spec-failure-card.test.ts`) exercise every field + every failure branch.
- **`needs_attention:true` is preserved on the agent_job.** The card ADDS a human-visible surface — it does NOT replace parking the agent_job. Both signals point at the same failure; either alone leaves it invisible (the pre-Phase-2 gap) or non-actionable.
- **Same shape as `cs_director_escalate_founder` on the surface.** Both use `type='agent_approval_request'` + `routed_to_function='ceo'` so `buildApprovalsFeed` reads them into the same escalated set — the founder sees them in one list. The distinct `escalation_kind` on metadata is how a downstream classifier (or the CEO reading the card) tells them apart.
- **Seed persists as `null` (not omitted).** When June's verdict itself lacks a `spec_seed`, `metadata.spec_seed` is explicitly `null` — not undefined — so a reader can distinguish "the seed was absent" from "the field was never written." Same convention `cs-director-escalate-founder-card` uses for `recommended_remedy`.
- **Title flags the failure class explicitly.** `"CS Director — author_spec FAILED (needs founder review)"` — never a bare "needs human review" (the Phase-2 verification's exact negation). The founder should see WHY at a glance in the approvals feed chip.

## Related

[[cs-director]] · [[cs-director-escalate-founder-card]] · [[cs-director-ticket-transition]] · [[author-spec]] · [[../tables/dashboard_notifications]] · [[../specs/june-authored-specs-carry-machine-runnable-checks]] · [[../functions/cs]] · [[../functions/ceo]]
