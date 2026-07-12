---
name: spec-review
description: RETIRED. The Vale LLM spec-review lane is retired ([[../../docs/brain/specs/retire-vale-spec-review-becomes-deterministic-authoring-gate]] Phase 3). The DETERMINISTIC spec-review gate ([[../../docs/brain/libraries/spec-review-gate]]) runs synchronously at the authoring chokepoint (`src/lib/author-spec.ts` `authorSpecRowStructured` / `authorSpecRowFromMarkdown`) and rejects a malformed spec on the spot with the exact named defect. There is no LLM verdict to emit, no `in_review` queue to sweep, and no `agent_jobs.kind='spec-review'` to claim.
---

# spec-review — RETIRED

**Do not invoke.** This skill is a stub kept for back-compat while the worker sunsets any residual `spec-review` job rows. The Vale LLM lane was retired by [[../../docs/brain/specs/retire-vale-spec-review-becomes-deterministic-authoring-gate]] Phase 3.

## What replaced it

The deterministic spec-review gate — a pure predicate + async wrapper at the authoring chokepoint:

- **`src/lib/spec-review-gate.ts`** — `computeSpecReviewProblems(input, ctx)` (pure) + `assertSpecReviewGate(workspaceId, input)` (async wrapper). Enforces the entire Vale checklist:
  - Contiguous `Phase N` sequence (no dup / gap / out-of-order)
  - Owner resolves to a `docs/brain/functions/` page
  - Parent resolves (typed `parent_kind`+`parent_ref`, bound `milestone_id`, or untyped `[[../goals/{slug}#{ms}]]` / `[[../functions/{fn}#{mandate}]]` prose)
  - Blocked-by slugs resolve + acyclic (cycle detection through the root)
  - Every phase carries a `### Verification` block
  - A `customer_id`-referenced table carries a companion `sonnet-orchestrator-v2` mention
- Thrown as `SpecReviewGateError` at author time — same fail-loud rail as `MissingVerificationError` / `MissingIntentError` / `InvalidParentError`.

## What was retired

- The Vale LLM lane on `agent_jobs.kind='spec-review'` (no new jobs enqueued).
- The Inngest `spec-review-cron` (15-min backstop) + `spec-review-on-mutate` (reactive) — both stubbed to unreachable triggers ([[../../src/lib/inngest/spec-review-cron.ts]] · [[../../src/lib/inngest/spec-review-on-mutate.ts]]).
- The `spec-review` rubric from `AGENT_RUBRICS` in [[../../src/lib/agents/agent-grader.ts]] (Vale is no longer a graded worker).
- The `agent:spec-review` monitored-loop entry — replaced by `spec-review-gate` (reactive) in [[../../src/lib/control-tower/registry.ts]] `MONITORED_LOOPS`.
- The derived `in_review` waiting-room in [[../../src/lib/brain-roadmap.ts]] `deriveSpecCardStatus` (a fresh, well-formed spec derives `planned` / `in_progress` via the phase rollup).
- The `queueRoadmapBuild` + `enqueueBuildIfDue` `in_review` / `not-review-passed` refuses (build claim is unblocked by construction).

## If a stale caller still invokes this skill

Return `{"status":"error","error":"skill spec-review is retired — the deterministic gate runs at the authoring chokepoint (src/lib/spec-review-gate.ts); no LLM verdict is emitted."}` and exit. The worker's `runSpecReviewJob` shim in `scripts/builder-worker.ts` is a completion no-op (its selector returns `[]` and it falls straight to Ada's disposition sweep tail).

## Related

- [[../../docs/brain/libraries/spec-review-gate]]
- [[../../docs/brain/specs/retire-vale-spec-review-becomes-deterministic-authoring-gate]]
- [[../../docs/brain/functions/platform]]
