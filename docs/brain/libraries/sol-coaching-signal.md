# libraries/sol-coaching-signal

The shared **"messy turns, but recovered"** coaching signal both Cora tiers emit so June (CS Director) can digest repeat patterns and commission a fix. The two graders judge the ENDING (see [[cora-triage-pass]] + [[ticket-analyzer]]): a ticket that ended resolved with a happy customer is NOT escalated. But the PATH there is still worth learning from — Sol contradicted a policy then corrected it, took three turns to find the order, mis-picked a tool then recovered. None of that warrants a June call (the customer was fine), but if the SAME stumble recurs across many tickets it's a systemic Sol gap June should fix at the source.

**File:** `src/lib/sol-coaching-signal.ts`

## The signal

Each grader emits ONE `sol_messy_turns` [[../tables/director_activity]] row per ticket whose ENDING was fine but whose MIDDLE was messy:

- the **cheap pass** ([[cora-triage-pass]]) emits it on a clean-close ticket it did NOT flag for a deep session (`needs_review=false`) but where Haiku still saw recovered mid-turn stumbles (`coachingSignals`).
- **Cora** (the deep box session, [[ticket-analyzer]]) emits it when her verdict is "no escalation" (satisfactory end) but issues remained — her own issue taxonomy is mapped to the shared vocab via `coraIssuesToMessySignals`.

**One tier emits per ticket per handling** — a flagged ticket is handled by Cora, so the cheap pass stays silent on it; there is no double-count.

## The vocab

`SOL_MESSY_TURN_SIGNALS` — the controlled set of RECOVERED-stumble classes, DISTINCT from the TERMINAL-failure signals in [[cora-triage-pass]] `TRIAGE_SIGNALS` (which describe a BAD ENDING and drive escalation). Every class here was recovered by the end, so the ticket was NOT escalated:

`contradiction_recovered` · `policy_misstate_recovered` · `slow_resolution` · `repeated_clarification` · `wrong_tool_recovered` · `tone_miss_recovered`

Plus the **tiered-ladder** class (distinct — the recovery is a re-session, not a clean close):

`cheap_tier_mishandle` — the LOW-COST path (Sonnet/Haiku) mishandled a ticket WITHOUT ever calling Sol; Cora caught it on the grade and RE-SESSIONED Sol rather than escalating June (see [[ticket-analyzer]] `decideRemediationTier`). It marks a systemic **cheap-path** gap June should fix at the source. Only ever emitted with `tier:'cheap'`; grouped + counted exactly like the recovered classes, so once it recurs across ≥ threshold tickets June's digest ([[cs-director-digest]] `composeMessyTurnWarnings`) proposes an `add_rule` fix for the Sonnet/Haiku handling.

## Exports

- `recordSolMessyTurns(admin, { workspaceId, ticketId, tier, signals, score?, summary? })` — emit ONE row. Best-effort, never throws; a no-op when no known signal survives `normalizeMessyTurnSignals` (an empty set is not a pattern worth a row). `directorFunction='cs'` (June owns Sol's coaching objective).
- `normalizeMessyTurnSignals(signals)` — keep only known vocab, dedupe, drop the rest.
- `SOL_MESSY_TURN_SIGNALS` / `SOL_MESSY_TURNS_KIND` — the vocab + the `director_activity.action_kind` string.

## The loop (north star)

A bounded proxy (per-ticket coaching flag) rolls up to the objective-owner (June) who decides the systemic fix — never a silent per-ticket auto-edit. June's weekly digest ([[cs-director-digest]] `composeMessyTurnWarnings`) groups the signals by class across DISTINCT tickets and surfaces an `early_warning` storyline + a proposed `add_rule` fix once a class recurs across ≥3 tickets. See [[../operational-rules]] § North star.

## Callers

- `src/lib/cora-triage-pass.ts` → `recordCheapPassClean` (tier `cheap`)
- `src/lib/ticket-analyzer.ts` → `applySeverityActions` no-escalation path (tier `cora`)

## Related

- [[cora-triage-pass]] · [[ticket-analyzer]] · [[cs-director-digest]] · [[../tables/director_activity]]

---

[[../README]] · [[../../CLAUDE]]
