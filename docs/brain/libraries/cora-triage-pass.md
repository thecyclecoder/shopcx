# libraries/cora-triage-pass

The **cheap triage tier** in front of Cora's expensive Max box session ([[ticket-analyzer]]). A single inline Haiku call — no box session, no tools — that decides whether a closed, Sol-handled ticket actually needs the full grading session, and writes a lightweight grade to [[../tables/ticket_analyses]] for the ones it clears. On a busy day the analyzer used to spawn ONE Max session per closed ticket; most tickets were handled fine and a full session on them tells us nothing new. This tier grades those itself and only spawns the deep session on a **terminal-state problem**.

**File:** `src/lib/cora-triage-pass.ts`

## Where it runs

Called from [[ticket-analyzer]] `enqueueTicketAnalyzeJob`, AFTER every skip gate (`merged_into` / `ai_disabled` / `analyzer_locked` / `do_not_reply` / `skip_tag`) and the one-in-flight dedup, gated on `trigger === "auto_close"` only. It inherits the same candidate set as the deep analyzer (closed + Sol-handled + settled ≥30 min — the trigger contract on [[ticket-analyzer]]) and never double-fires against an in-flight ticket. A `manual` / `manual_close` / `reopen_close` trigger bypasses the cheap tier and forces the deep grade.

## Layering — never escalates to June, only to the deep session

The cheap pass NEVER reaches June (CS Director). Its ONLY escalation is spawning the deep Cora session (by returning `needsReview` / failing open, so `enqueueTicketAnalyzeJob` falls through to its `agent_jobs` insert). June is reached solely from INSIDE that deep session (`decideEscalationAction` → [[../inngest/triage-escalations]] → `cs-director-call`). Two hops, never one — the cheap tier cannot reopen a ticket, notify a human, or write a director-decision row. This is the same bounded-proxy / supervisable-autonomy rail as everywhere else (CLAUDE.md § North star): a cheap proxy grader can flag for review, but only the objective-owner layer above it escalates.

## Terminal-state principle

The pass flags only END-state failures, not the messy middle — the same principle as `hasResolvedActionClose` on [[ticket-analyzer]] (founder decision, 2026-07: "escalate on getting it wrong at the END, not mid-turn"). Support is a process; customers describe things messily and agents legitimately state a reasonable-but-wrong interim position, then correct as facts arrive. A turn-1 stumble that was RECOVERED by the end is NOT a trip. `TRIAGE_SIGNALS` (the exported allowed set) are all terminal failure modes: `customer_unresolved`, `customer_frustrated_end`, `unkept_promise`, `out_of_policy_offer`, `false_outcome_claim`, `wrong_outcome`.

## Coaching signal on a clean-but-messy close

The classifier returns `coachingSignals` (a subset of [[sol-coaching-signal]] `SOL_MESSY_TURN_SIGNALS`) SEPARATELY from `signals` — recovered mid-turn stumbles that never change `needsReview` (the customer ended fine) but are worth learning from. On the clean-close path (`recordCheapPassClean`), the cheap pass emits ONE `sol_messy_turns` [[../tables/director_activity]] row (tier `cheap`) via `recordSolMessyTurns` so June can digest repeat patterns. The cheap pass owns the tickets it did NOT flag, so Cora never also emits for them — no double-count. See [[sol-coaching-signal]] + [[cs-director-digest]].

## Recall-biased gate

The gate fails OPEN: an unparseable classifier output, a missing `needs_review` field, a contradictory verdict (clean but with signals), or a hard runtime failure (no API key, transport error, empty transcript) all route to the deep session. The cheap pass NEVER silently suppresses a ticket it couldn't confidently clear — better an over-review than a missed terminal failure.

## Exports

### `runCheapTriagePass` — async function

```ts
async function runCheapTriagePass(admin: Admin, ticketId: string): Promise<TriageRun | null>
```

Loads the ticket + `ticket_messages`, renders a capped customer/AI transcript (internal notes dropped, bodies cleaned via [[email-cleaner]]), calls Haiku once, and returns the parsed verdict + window/token metadata. Returns `null` on a HARD failure (no `ANTHROPIC_API_KEY`, fetch/HTTP failure, or no gradeable messages) so the caller fails open to a deep review.

### `recordCheapPassClean` — async function

```ts
async function recordCheapPassClean(admin, workspaceId, ticketId, run: TriageRun, trigger: string): Promise<void>
```

Called ONLY on a clean verdict (`needsReview === false`). Writes a lightweight `[cheap-pass]` [[../tables/ticket_analyses]] row via [[ticket-analyses-table]] `insertAnalysis` (`model=claude-haiku-4-5…`, `apiBilled=true` — the cheap pass runs inline on the paid API, never the Max box lane, so its cents are real) and stamps `tickets.last_analyzed_at` so the cron treats this handling as graded and won't re-select it. A trip enqueues the deep session instead (which writes its own authoritative row), so a ticket is never double-written.

### `buildTriagePrompt` / `parseTriageResult` — pure functions

```ts
function buildTriagePrompt(transcript: string): { system: string; user: string }
function parseTriageResult(text: string): TriageResult
```

Pure + deterministic (no Anthropic call, no DB) so the prompt shape + recall-biased parsing are unit-pinned without a network call. `parseTriageResult` clamps score to 1–10, keeps only known `TRIAGE_SIGNALS`, and fails open (`{ needsReview: true, signals: ["parse_error"] }`) on any malformed/contradictory input. Tests: `src/lib/cora-triage-pass.test.ts`.

## Callers

- `src/lib/ticket-analyzer.ts` → `enqueueTicketAnalyzeJob` (the gate)

## Related

- [[ticket-analyzer]] — the deep Cora box session this tier gates + § Cheap triage tier
- [[ticket-analyses-table]] — `insertAnalysis` (the lightweight-grade write)
- [[../tables/ticket_analyses]] · [[../lifecycles/ai-analysis]] · [[email-cleaner]]

---

[[../README]] · [[../../CLAUDE]]
