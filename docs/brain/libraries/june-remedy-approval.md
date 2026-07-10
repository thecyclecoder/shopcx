# libraries/june-remedy-approval

The **founder-approval gate on the CS Director's money remedies**. June ([[cs-director]]) autonomously executes most remedies on an escalated ticket — date changes, coupons within limit, replacements, resends, sub-threshold refunds. But a **refund / credit / dollar-replacement whose SUM across the batch is above a per-workspace threshold** routes to the founder (Dylan) for a **yes / no / ask** decision **before** it fires, delivered by SMS + Eve's cockpit ([[god-mode]]).

**File:** `src/lib/june-remedy-approval.ts`

North star ([[../operational-rules]] § supervisable autonomy): June optimizes a bounded proxy (resolve the ticket); a spend over the rail **escalates to the objective-owner** (the founder) rather than executing silently. Hitting the rail = ask, not execute.

**Gate SUMS across the WHOLE batch** ([[../specs/june-full-sdk-power-multi-action-remedies-with-gate-summing]] Phase 3, 2026-07-10). Since June can now author a multi-action `RemedyPlan` (`{actions: [{action_type, payload}, ...]}`), the gate MUST sum money across every money action in the batch — a fix can't dodge the $50 gate by splitting a $60 refund into 2×$30 (both `partial_refund` steps count into the SUM). See § [Gate-summing across multi-action](#gate-summing-across-multi-action) below.

## The flow (locked with Dylan 2026-07-10)

1. **`handleApproveRemedy`** ([[cs-director]]) calls `remedyNeedsFounderApproval(remedy, threshold)` **before** executing.
2. **Gated → `raiseJuneRemedyApproval`**: ensure a cockpit session (reuse the active Eve session, arm one if none), `openApproval` (the parked remedy lives in the card's `tool_input`), `sendGodModeSMS` immediately (a customer is waiting — no 5-min nudge delay), and hold the ticket **escalated to the owner** with an "Awaiting founder approval: …" reason. **No execution, no customer message yet.** `handleApproveRemedy` returns `awaiting_founder_approval: true`.
3. The runner ([[../recipes/cs-director-runner|scripts/builder-worker.ts]] `runCsDirectorCallJob`) sees `awaiting_founder_approval` and **skips** the usual approve_remedy de-escalate/close transition **and** the generic verdict note — the ticket stays escalated until Dylan decides.
4. Dylan taps **Approve / Deny / Ask** in Eve's cockpit (the same god-mode surface as any decision card).
5. **`executeApprovedJuneRemedies`** — the box-worker ~60s god-mode sweep — picks up the decided card:
   - **Approve →** execute the parked remedy through the production executor (`executeSonnetDecision`, execute-then-message invariant), deliver the customer reply **in the channel persona (never "June")** via `deliverTicketMessage`, then close + de-escalate.
   - **Deny →** post an internal note ("Founder DECLINED… no money moved"), leave the ticket escalated for a human.
   - Idempotent via an `executed_at` stamp inside the card's `tool_input` — **no schema change on [[../tables/god_mode_approvals]]**.

## Exports

| Export | Kind | What |
|---|---|---|
| `MONEY_ACTION_TYPES` | `Set<string>` | The remedy action types the gate covers: `partial_refund`, `redeem_points_as_refund`, `create_replacement_order`, `dollar_replacement`. |
| `JUNE_REMEDY_TOOL` | `"june_remedy"` | The `tool_name` on the [[../tables/god_mode_approvals]] card that carries a parked remedy. |
| `JUNE_REFUND_CATEGORY` | `"june_refund"` | The decision `category` — drives standing "don't ask again" grants ([[../tables/god_mode_standing_grants]]). |
| `DEFAULT_REFUND_APPROVAL_THRESHOLD_CENTS` | `5000` | Fallback threshold ($50) when the workspace column is missing/unreadable. |
| `MoneyActionLine` | interface | One per-money-action line: `{ actionType, amountCents }` (amountCents null when unknown). Populated by `extractRemedyMoneyLines` in June's authored order. |
| `extractRemedyMoneyLines(remedy)` | pure | Walks EITHER shape (legacy `{action_type, payload}` OR multi-action `{actions:[...]}`) and returns the ordered per-money-action lines; non-money actions skipped. |
| `remedyMoneyAmountCents(remedy)` | pure | The **SUM** of money (cents) across every money action in the batch, or `null` if any money action has an unknown amount OR the batch has no money actions. Reads `payload.amount_cents` then `payload.replacement_amount_cents`. |
| `remedyNeedsFounderApproval(remedy, thresholdCents)` | pure | `{ gated, actionType, amountCents, moneyLines }`. Gated when the **SUMMED** total is strictly above the threshold OR any money action's amount is unknown. `amountCents` is the SUM (null for unknown); `moneyLines` is the ordered per-money-action list. Non-money-only batches + sub-threshold sums run autonomously. Reads the remedy's raw `action_type` field (the prompt-authored value). |
| `planNeedsFounderApproval(actions, thresholdCents)` | pure | `{ gated, actionType, amountCents, moneyLines }`. Same semantics as `remedyNeedsFounderApproval` — money actions are summed across the batch, ANY unknown amount collapses the sum to null (→ gate), non-money-only batches run autonomously — but reads the plan's canonical `actionType` for each step (from `plan.actions[]`, the normalized types the executor will fire). Closes the payload.type-override bypass: the sum the gate asserts is EXACTLY the set of action types the executor will fire. Called by `handleApproveRemedy` ([[cs-director]]) instead of the raw-remedy gate. |
| `buildJuneApprovalPreview({...})` | pure | The plain-language card/SMS text Dylan reads. **Multi-line** (moneyLines.length ≥ 2): "Approve $60.00 in refunds/credits to Susan on 'Wrong price'? • partial_refund: $30.00 • redeem_points_as_refund: $30.00 … Why: …" (names the SUM up-front + lists each line so a 2×$30 split can't hide the true $60 spend). **Single-line** (length ≤ 1): the legacy "Refund $48.00 to Susan on 'Wrong price'? … Why: …" — unchanged. |
| `getRefundApprovalThresholdCents(admin, workspaceId)` | IO | Reads `workspaces.june_refund_approval_threshold_cents`; best-effort, falls back to $50. |
| `raiseJuneRemedyApproval(admin, input)` | IO | Park the gated remedy: raise the card, text the founder, hold the ticket escalated. Accepts optional `moneyLines` (falls back to `extractRemedyMoneyLines(remedy)`); stashes them on `tool_input.money_lines` (JSONB, no schema change) so the cockpit UI + sweep can show the split without re-walking. Fallback `via: "escalated_no_cockpit"` (internal note) if no cockpit can be established — the approval is **never silently dropped**. |
| `executeApprovedJuneRemedies(admin)` | IO | The ~60s sweep: `{ executed, denied }`. Fires approved cards through `executeParkedRemedy` (runs the WHOLE batch through `executeSonnetDecision`, execute-then-message across all actions), notes denied ones, stamps `executed_at`. |
| `JUNE_FOUNDER_ESCALATION_CATEGORY` | `"june_founder_escalation"` | The decision `category` for a founder-escalation approval card (distinct from `june_refund`; a recommendation is not a standing "don't ask again" grant class). |
| `buildFounderApprovalPreview({ remedy, reasoning?, customerName?, ticketSubject? })` | pure | The plain-language SMS line the founder reads for ANY `escalate_founder` recommended remedy — not just money. Reuses the dollarized summary for money actions; special-cases `add_one_time_gift` ("Comp a FREE one-time gift for <name>" / "Add a one-time item"); generic `Run "<type>"` / "June's recommended action" fallback. Reasoning truncated to 500 chars. Unit-tested (`june-remedy-approval.founderPreview.test.ts`, 7 cases). |
| `raiseFounderApproval(admin, { workspaceId, ticketId, remedy, reasoning, customerName?, ticketSubject? })` | IO | Turn a June `escalate_founder` **recommended remedy** into an actionable phone approval: arm/reuse the Eve cockpit, `openApproval` (`tool_name=JUNE_REMEDY_TOOL` so the existing `executeApprovedJuneRemedies` sweep runs it on Approve), `sendGodModeSMS`, hold the ticket escalated. Called by [[cs-director]] `handleEscalateFounder` when the verdict names a concrete remedy (founder directive: "anything June seeks from me should be a straight-up approval"). Non-fatal on cockpit/SMS failure — the CEO dashboard card is still the durable record. |

## The threshold

`workspaces.june_refund_approval_threshold_cents` — `integer not null default 5000` (migration `20260710120000_june_refund_approval_threshold.sql`). Strictly-above the SUM routes to Dylan; at-or-below runs autonomously. See [[../tables/workspaces]].

<a id="gate-summing-across-multi-action"></a>

## Gate-summing across multi-action

The multi-action-remedies spec's Phase 3 invariant: the gate SUMS money across every money action in `remedy.actions[]` and gates on the TOTAL. Concretely:

| Batch shape                                                          | Sum   | Threshold | `gated` | Note                                                                                                     |
|----------------------------------------------------------------------|-------|-----------|---------|----------------------------------------------------------------------------------------------------------|
| single `partial_refund $30`                                          | $30   | $50       | false   | legacy single-action shape — sub-threshold → autonomous                                                  |
| single `partial_refund $60`                                          | $60   | $50       | **true**| legacy single-action shape — over-threshold                                                              |
| `[partial_refund $30, partial_refund $30]`                           | $60   | $50       | **true**| **can't split a refund to dodge the gate** — 2×$30 behaves identically to a single $60                    |
| `[partial_refund $20, redeem_points_as_refund $20]`                  | $40   | $50       | false   | sum under threshold → autonomous                                                                          |
| `[partial_refund $30, partial_refund <unknown>]`                     | null  | $50       | **true**| any unknown-amount money action collapses the SUM to null → gate (never auto-fire a refund we can't size) |
| `[partial_refund $60, change_next_date {…}]`                         | $60   | $50       | **true**| non-money actions ignored — the gate reads money-only SUM ($60)                                          |
| `[change_next_date {…}, resume {…}]`                                 | —     | $50       | false   | no money actions in the batch → nothing to gate                                                          |

Enforced by pure predicates ([[../../src/lib/june-remedy-approval.ts]] `extractRemedyMoneyLines` + `remedyMoneyAmountCents` + `remedyNeedsFounderApproval`) — unit-tested against every row above in `src/lib/june-remedy-approval.test.ts`. Downstream: the raise path stashes `money_lines[]` on `god_mode_approvals.tool_input` so the cockpit UI + audit surfaces can render the split alongside the SUM without re-walking the raw remedy.

## Security fix — gates on NORMALIZED planned actions (2026-07-10)

[[../specs/fix-june-remedy-payload-type-gate-bypass]] closed a vulnerability where `remedyNeedsFounderApproval` (which reads the remedy's raw `action_type` field) could be bypassed if a prompt-influenced payload fields override the executable action type after gating. **`handleApproveRemedy` ([[cs-director]]) now calls `planNeedsFounderApproval(plan.actions, threshold)` instead**, which:

1. Reads the plan's canonical `actionType` for each step — the NORMALIZED types that `extractActionStep` resolved and that the executor will fire.
2. Sums money across the same actions the executor will execute, not the raw remedy's prompt-authored fields.
3. Guarantees the sum the gate asserts matches exactly the action types that will execute — a bypass where payload fields override the action type after gating is no longer possible.

`remedyNeedsFounderApproval` still exists for callers that work with the raw remedy shape (e.g. the preview builder + audit surfaces) and is unit-tested separately.

## Gotchas

- **Strictly-above the SUM, not at-or-above.** A batch whose money total is exactly the threshold runs autonomously; only `sum > threshold` (or an unknown amount on any money action) gates.
- **Unknown amount ANYWHERE in the batch gates.** Even if the KNOWN portions of the batch sum under threshold, an unknown amount on any money action forces the gate — we never fire a refund we can't size.
- **Only money actions count.** Date changes, coupons, pauses, resends, address fixes are never gated regardless of the (irrelevant) numbers in their payload — `MONEY_ACTION_TYPES` is the whole surface. A mixed batch sums ONLY the money actions.
- **June still emits `approve_remedy`, not `escalate_founder`, for a gated batch.** The [[cs-director-call]] skill carries the FULL multi-action remedy + a persona `customer_message`; the gate is the worker's job. Downgrading to `escalate_founder` would lose the ready-to-fire remedy.
- **The preview names the SUM up-front + lists each money line** when moneyLines.length ≥ 2 — so a 2×$30 split can't hide the true $60 spend from the founder. Single-line preview renders the legacy "Refund $48.00 to Susan on 'Wrong price'?" string unchanged.
- **Idempotency is in `tool_input.executed_at`** — no column added to `god_mode_approvals`. The sweep skips any card already stamped. On a thrown execution error the stamp is NOT written, so the next sweep retries.
- **Customer message is the channel persona (e.g. Suzie), never "June."** Delivered verbatim by `deliverTicketMessage` after ALL actions in the batch verify.

## Related

- [[cs-director]] — `handleApproveRemedy` (the gate call site), `planRemedyExecution`, `buildRemedySonnetDecision`, `parseBatchEvent`, `summarizeRemedyBatchOutcome`
- [[../specs/june-full-sdk-power-multi-action-remedies-with-gate-summing]] — the spec that added multi-action `actions[]` + gate-summing
- [[god-mode]] — `getActiveSession` / `armSession` / `openApproval` / `sendGodModeSMS` (the cockpit primitives this drives)
- [[../tables/god_mode_approvals]] — the `tool_name='june_remedy'` card this parks + sweeps
- [[../tables/workspaces]] — `june_refund_approval_threshold_cents`
- [[../lifecycles/god-mode]] — the Eve cockpit + SMS decision surface
- [[cora-triage-pass]] · [[ticket-analyzer]] — the Cora/June dial-in this landed with
