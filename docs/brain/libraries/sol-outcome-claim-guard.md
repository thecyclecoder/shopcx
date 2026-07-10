# sol-outcome-claim-guard

`src/lib/sol-outcome-claim-guard.ts` — Phase 3 of the **message-is-last** pipeline. The terminal send guard: a customer-facing message may CLAIM an outcome (e.g. "I added a second bag to your next order", "I applied a $15 credit", "here is your prepaid return label") only if the ticket's [[../tables/ticket_required_outcomes]] row for that outcome is `status='verified'`. A message that asserts an unverified claim is BLOCKED (never reaches the customer) and the turn's [[../tables/ticket_resolution_events]] row is stamped `verified_outcome='unbacked'` — the M1 inline-verify bounce the brain used to mark "none yet". See [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]].

Sibling to [[sol-policy-bait-guard]]: both are deterministic backstops on Sol's DRAFT reply, both preserve the Direction (Sol's reasoning stays durable for the grader/coach), both escalate a blocked reply to June (the CS final call) to re-draft. The distinction:
- **sol-policy-bait-guard** fires when the reply mismatches Sol's own POLICY VERDICT (out-of-policy promises, multi-remedy stacks).
- **sol-outcome-claim-guard** fires when the reply mismatches the DB TRUTH (a claim without a verified backing row).

## Exports

| Symbol | Signature | Purpose |
|---|---|---|
| `CLAIM_KIND_PATTERNS` | `Record<string, RegExp[]>` | Per-kind claim regexes. Seed set covers Judy-adjacent kinds (`add_bag_to_next_order`, `apply_coupon`, `partial_refund`, `create_replacement`) + common lifecycle actions (`cancel`, `pause`, `resume`, `create_return`). A kind absent from this map is skipped — the guard fails open on unknown kinds so a novel action type can't over-block a legit reply. |
| `BlockedClaim` | interface | `{outcome_id, kind, description, current_status, matched_phrase}` — one CLAIM the guard blocked, surfaced verbatim to the escalation reason. |
| `OutcomeClaimAssessment` | union: `{ok:true} \| {ok:false, blocked_claims, reason}` | Shape mirrors `sol-policy-bait-guard.SolReplyBaitAssessment` so callers can compose the two guards. |
| `OutcomeClaimContext` | interface | `{message, outcomes}` — the input to the pure predicate. |
| `assessOutcomeClaims(ctx)` | pure | Regex over the message + per-kind pattern lookup. Per-outcome: skip if `status='verified'`, skip if kind has no patterns, otherwise scan for the first match. |
| `stampUnbackedOnLedger(admin, {workspace_id, resolution_event_id})` | mutation | Compare-and-set `ticket_resolution_events.verified_outcome='unbacked'` on `verified_at IS NULL` + workspace_id (learning #5 — re-assert the read-time predicate in the write). Idempotent, never throws. |
| `assertClaimsBackedByOutcomes({admin, workspace_id, ticket_id, message, resolution_event_id?})` | wire-in | Loads outcomes via `listRequiredOutcomes`, calls the predicate, stamps the ledger 'unbacked' on block when the caller supplies a `resolution_event_id`. |

## Wire-in sites

- **`scripts/builder-worker.ts` `runTicketHandleJob`** — right after `assessSolReplyBaitRisk` passes, BEFORE `deliverTicketMessage` fires. A block writes the reason + matched phrases to `job.log_tail`, leaves the Direction durable, and the customer never sees the baited turn. This is the Sol box-reply path — the primary Phase 3 wire-in.
- Future wire-ins (still deferred to their own follow-up work):
  - `src/lib/action-executor.ts` `executeSonnetDecision` — every `stampedSend` branch (`direct_action`'s confirmation, `journey`/`playbook`'s in-flight sends, `workflow.sendReply`, `macro`/`kb_response`/`ai_response`, clarification). At those sites the caller has a `_resolutionEventId` and passes it, so the 'unbacked' stamp lands on the write-ahead ledger.
  - `src/app/api/tickets/[id]/improve/*` — Improve tab manual sends.

## Pattern design

Patterns match:
- past-tense completion (`I've added a second bag`, `applied a $15 credit`, `issued a $25 refund`, `here is your prepaid label`)
- future-tense promise (`I'll add a second bag`, `we'll issue a refund`) — a promise is still an assertion the outcome will happen
- third-person state (`your subscription is cancelled`, `your next order will include a bag`)

Patterns do NOT match:
- QUESTIONS (`would you like me to add a bag?`) — no assertion
- OFFERS (`I can add a bag if you want`) — no completion / commitment
- POLICY REFERENCES (`subscription renewals aren't eligible for return`) — same design as [[sol-policy-bait-guard]]'s promise-vs-reference distinction.

Coverage is intentionally conservative: false negatives (a novel phrasing slips through) are recoverable via the Phase-4 completion gate; false positives (a legit reply is blocked) would strand tickets escalated to June on every phrasing edge case.

## Tests

`src/lib/sol-outcome-claim-guard.test.ts` — 16 unit tests covering:
- Judy's failing state (message claims both bag + credit while both outcomes UNVERIFIED → BLOCKED naming both).
- Judy partial verify (bag verified, credit pending → only credit blocked).
- Judy both verified (message claims both, both DB-backed → OK).
- Truthful escalating reply (bag verified, credit failed, reply names the credit as escalated → OK — doesn't claim it applied).
- Question-form / offer-form / policy-reference phrasings (no false positive).
- Future-tense promise (`I'll add a second bag` while row pending → BLOCKED).
- Refund / replacement / return / cancel / pause seed kinds.
- Unknown kind → SKIPPED (fail open).
- CLAIM_KIND_PATTERNS structural sanity (no empty pattern set slips through).

Run: `npx tsx --test src/lib/sol-outcome-claim-guard.test.ts`

## Invariants

- **Only `status='verified'` opens the gate.** `done` (executor fired but DB verify hasn't confirmed) and `failed` (executor escalated) both leave the row's claims blocked — the send guard's predicate stays a single-line `status === 'verified'` comparison (same shape as Phase-2's `replyGateBlocked`).
- **Fail open on unknown kinds.** A kind absent from `CLAIM_KIND_PATTERNS` produces no patterns to scan, so a novel action type never over-blocks a legit reply. The Phase-4 completion gate ensures such a novel action still can't auto-resolve while its row is unverified.
- **Ledger stamp is best-effort.** `stampUnbackedOnLedger` never throws — the guard's block behavior is the critical path, not the ledger write. Same invariant as [[action-executor]]'s `stampResolutionShipped`/`stampResolutionVerified`.

---

[[../README]] · [[../tables/ticket_required_outcomes]] · [[../tables/ticket_resolution_events]] · [[../tables/ticket_directions]] · [[ticket-required-outcomes]] · [[honor-required-outcomes]] · [[sol-policy-bait-guard]] · [[action-executor]] · [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] · [[../goals/guaranteed-ticket-handling]] · [[../functions/cs]] · [[../../CLAUDE]]
