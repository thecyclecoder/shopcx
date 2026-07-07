# inngest/playbook-compiler

Weekly cron that mines the [[../tables/ticket_resolution_events]] write-ahead ledger for recurring problem × resolution patterns and proposes new playbook-shaped rules into the existing [[../tables/sonnet_prompts]] approval queue. Phase 1 of the **playbook-compiler loop** — M4 of [[../goals/guaranteed-ticket-handling]].

**File:** `src/lib/inngest/playbook-compiler.ts` (thin cron wrapper) · logic in `src/lib/playbook-compiler.ts` (mining, clustering, drafting — extracted so it's unit-testable).

Turns the resolution ledger into growing tree coverage: every week, patterns the orchestrator kept getting right converge into a proposed rule an admin can approve with one click at `/dashboard/settings/ai/prompts`. On approval the rule flips `status='approved', enabled=true` and the next [[unified-ticket-handler]] run concatenates it into the system prompt.

## Functions

### `playbook-compiler`
- **Triggers:**
  - cron `0 12 * * 1` — Mondays 12:00 UTC (7 AM Central during CDT, 6 AM CST). Weekly cadence gives admins a predictable time to see fresh drafts.
  - event `playbook-compiler/run` — manual invocation (Inngest dashboard "Invoke", or `inngest.send` from anywhere in code) for out-of-band sweeps.
- **Concurrency:** `[{ limit: 1 }]` — one workspace-sweep at a time across all workspaces. The Sonnet drafting cost is bounded and serial keeps the burn predictable.
- **Retries:** 1

## Loop

For every workspace with any confirmed [[../tables/ticket_resolution_events]] in the last **30 days**:

1. **Read** all rows where `verified_outcome='confirmed'` and `staged_at >= now() - 30d` for the workspace.
2. **Cluster** by `(problem, sorted-action-shape-types)`. The action-shape types come from `options[chosen.option_index].action_shape` — walked recursively so a bundled `replacement + partial_refund` shape surfaces both. Support is counted per **distinct ticket_id**, not per turn (a two-turn ticket doesn't double-count).
3. **Filter** clusters where `support < SUPPORT_MIN`. Default 15; workspaces can pin their own on `workspaces.playbook_compiler_support_min` (the compiler falls back to the default when the column is missing).
4. **Dedupe** against existing `sonnet_prompts` rows whose title matches the deterministic `Playbook rule — <problem> → <actions>` slug (title matches from `status ∈ {approved, proposed}`). Same dedupe pattern as [[../libraries/daily-analysis-report]].
5. **Draft** each remaining cluster via a small Sonnet call (`claude-sonnet-4-6`, max 800 output tokens). The model returns `{title, body}`; the body reads as an imperative rule the orchestrator will inject verbatim.
6. **Insert** one [[../tables/sonnet_prompts]] row per draft:
   - `category='rule'` · `status='proposed'` · `enabled=false` · `proposed_at=now()` · `sort_order=200`
   - Mirrors the insert shape in `src/lib/daily-analysis-report.ts:170`.
   - Surfaces on `/dashboard/settings/ai/prompts` with Approve / Decline buttons — the existing queue.

Sonnet-call token usage lands in `ai_token_usage` via [[../libraries/ai-usage]] `logAiUsage` (purpose `playbook_compiler_draft`).

## Downstream events sent

- `playbook-compiler/run` — the manual trigger this same function accepts. Sending from an admin one-off will fan the same sweep.

## Tables written

- [[../tables/sonnet_prompts]] — one row per drafted rule (`status='proposed'`, `enabled=false`, `category='rule'`).
- [[../tables/ai_token_usage]] — one row per Sonnet draft call (purpose `playbook_compiler_draft`), via [[../libraries/ai-usage]] `logAiUsage`.

## Tables read (not written)

- [[../tables/ticket_resolution_events]] — the mining source (`verified_outcome='confirmed'`, last 30 days).
- [[../tables/sonnet_prompts]] — for dedupe against existing rules.
- [[../tables/workspaces]] — optional per-workspace `playbook_compiler_support_min` override.

## Invariants

- **Never overwrite a human-approved rule.** The compiler only ever inserts new `status='proposed'` rows. Approval flips the row to `approved+enabled`; a subsequent compiler run dedupes against that title.
- **Draft failures don't stall the batch.** Sonnet call / parse failures for one cluster surface as a warn log; the sweep moves on to the next cluster.
- **A confirmed turn is required.** The mine is deliberately scoped to `verified_outcome='confirmed'` — patterns the orchestrator got right AND that survived M1's inline verify. `drifted` / `unbacked` / `clarified` rows are excluded; they're compiler signal *against* proposing a rule.
- **Per-ticket support.** Support counts distinct `ticket_id`s, not turns — a repeat-firing on the same ticket is one data point, not many.

## Related

- Parent spec: [[../specs/playbook-compiler-loop-mine-resolution-records-and-audit-existing-playbooks]] — Phase 1 (this cron), Phase 2 (existing-playbook audit surface), Phase 3 (matcher defer + fail-fast escalation).
- Parent goal / milestone: [[../goals/guaranteed-ticket-handling]] § M4 "Capability + compiler loop".
- Substrate: [[../tables/ticket_resolution_events]] — the write-ahead ledger. Read path M4 uses `verified_outcome` to scope to confirmed turns; the ledger's row lifecycle (`staged_at → shipped_at → verified_at + verified_outcome`) is documented on that page.
- Approval queue: [[../dashboard/settings/ai__prompts]] (the existing Approve/Decline UI the compiler drafts land in).

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
