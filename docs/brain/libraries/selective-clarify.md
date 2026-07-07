# libraries/selective-clarify

Selective clarification gate — intercept the ~6% of Sonnet decisions that are BOTH low-confidence AND irreversible, and send a scoped confirmation-turn instead of the action. The opposite of blanket-clarifying every ambiguous ticket (~38% turns for ~0 benefit — the regime the parent goal [[../goals/guaranteed-ticket-handling]] rejects).

**File:** `src/lib/selective-clarify.ts`

Phase 2 of [[../specs/confidence-gated-problem-lockin-and-selective-clarify]]. Wired at the top of `executeSonnetDecision`'s `direct_action` branch in [[action-executor]] — on a hit, it sends the confirmation message via `trackedSend`, stamps [[../tables/ticket_resolution_events]] `verified_outcome='clarified'`, and skips `handleDirectAction`. Sandbox mode bypasses the gate (its stamped-note dry-run is already non-destructive).

## Exports

- `DEFAULT_CLARIFY_CONFIDENCE_THRESHOLD` — `0.7`, aligned with the problem-lockin default on [[../tables/ai_channel_config]] so the two thresholds move together.
- `DEFAULT_IRREVERSIBLE_SET` — `{partial_refund, cancel, bill_now, subscriptionOrderNow}`. Actions whose blast radius is real money / a broken subscription / a lost billing cycle.
- `shouldClarify(input, opts?)` — pure predicate: `true` iff confidence < threshold AND at least one action's `type` is in the irreversible set. Non-triggers pinned by unit test: null/absent confidence, reversible-only batch, high confidence on an irreversible action.
- `buildClarificationMessage(actions)` — plain-text confirmation copy ("Just to confirm before I refund $X, is that right?"). No markdown (CLAUDE.md AI response rule).
- `loadIrreversibleSet(admin, workspaceId)` — reads the `policies` row where `slug='irreversible_actions'` (rules JSONB: `[{action: "type"}, ...]`) so a workspace can override the default without a code change. Missing / malformed → the default set (a broken policy edit can never disable the gate).

## Callers

- [[action-executor]] `executeSonnetDecision` → `direct_action` branch (the gate).
- `/api/tickets/analytics/selective-clarify` route → the "Selective-clarify rate (target ~6%)" tile on `/dashboard/tickets/analytics`, computed off [[../tables/ticket_resolution_events]] `verified_outcome='clarified'` over a rolling 7-day window.

## Tests

`src/lib/selective-clarify.test.ts` pins the spec's Phase-2 verification pair: low-confidence × irreversible partial_refund → clarify; low-confidence × reversible apply_coupon → execute. Run: `npx tsx --test src/lib/selective-clarify.test.ts`.

## Related

[[action-executor]] · [[ai-context]] · [[../tables/ticket_resolution_events]] · [[../tables/ai_channel_config]] · [[../tables/policies]] · [[../lifecycles/ai-multi-turn]] · [[../specs/confidence-gated-problem-lockin-and-selective-clarify]] · [[../goals/guaranteed-ticket-handling]]
