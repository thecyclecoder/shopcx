# libraries/june-remedy-approval

The **founder-approval gate on the CS Director's money remedies**. June ([[cs-director]]) autonomously executes most remedies on an escalated ticket — date changes, coupons within limit, replacements, resends, sub-threshold refunds. But a **refund / credit / dollar-replacement above a per-workspace threshold** routes to the founder (Dylan) for a **yes / no / ask** decision **before** it fires, delivered by SMS + Eve's cockpit ([[god-mode]]).

**File:** `src/lib/june-remedy-approval.ts`

North star ([[../operational-rules]] § supervisable autonomy): June optimizes a bounded proxy (resolve the ticket); a spend over the rail **escalates to the objective-owner** (the founder) rather than executing silently. Hitting the rail = ask, not execute.

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
| `remedyMoneyAmountCents(remedy)` | pure | The money amount (cents) a remedy moves, or `null` if it's not a money action / amount unknown. Reads `payload.amount_cents` then `payload.replacement_amount_cents`. |
| `remedyNeedsFounderApproval(remedy, thresholdCents)` | pure | `{ gated, actionType, amountCents }`. Gated when a money action is **strictly above** the threshold **OR** its amount is unknown (never auto-fire a refund we can't size). Non-money + at/below-threshold run autonomously. |
| `buildJuneApprovalPreview({...})` | pure | The plain-language card/SMS text Dylan reads ("Refund $48.00 to Susan on 'Wrong price'? … Why: …"). |
| `getRefundApprovalThresholdCents(admin, workspaceId)` | IO | Reads `workspaces.june_refund_approval_threshold_cents`; best-effort, falls back to $50. |
| `raiseJuneRemedyApproval(admin, input)` | IO | Park the gated remedy: raise the card, text the founder, hold the ticket escalated. Fallback `via: "escalated_no_cockpit"` (internal note) if no cockpit can be established — the approval is **never silently dropped**. |
| `executeApprovedJuneRemedies(admin)` | IO | The ~60s sweep: `{ executed, denied }`. Fires approved cards, notes denied ones, stamps `executed_at`. |

## The threshold

`workspaces.june_refund_approval_threshold_cents` — `integer not null default 5000` (migration `20260710120000_june_refund_approval_threshold.sql`). Strictly-above routes to Dylan; at-or-below runs autonomously. See [[../tables/workspaces]].

## Gotchas

- **Strictly-above, not at-or-above.** A remedy exactly at the threshold runs autonomously; only `amount > threshold` (or an unknown amount) gates.
- **Unknown amount gates.** A money action with no readable amount is conservatively gated — we never fire a refund we can't size.
- **Only money actions gate.** Date changes, coupons, pauses, resends, address fixes are never gated regardless of the (irrelevant) numbers in their payload — `MONEY_ACTION_TYPES` is the whole surface.
- **June still emits `approve_remedy`, not `escalate_founder`, for a gated refund.** The [[cs-director-call]] skill carries the full remedy + a persona `customer_message`; the gate is the worker's job. Downgrading to `escalate_founder` would lose the ready-to-fire remedy.
- **Idempotency is in `tool_input.executed_at`** — no column added to `god_mode_approvals`. The sweep skips any card already stamped. On a thrown execution error the stamp is NOT written, so the next sweep retries.
- **Customer message is the channel persona (e.g. Suzie), never "June."** Delivered verbatim by `deliverTicketMessage` after the action verifies.

## Related

- [[cs-director]] — `handleApproveRemedy` (the gate call site), `planRemedyExecution`, `buildRemedySonnetDecision`
- [[god-mode]] — `getActiveSession` / `armSession` / `openApproval` / `sendGodModeSMS` (the cockpit primitives this drives)
- [[../tables/god_mode_approvals]] — the `tool_name='june_remedy'` card this parks + sweeps
- [[../tables/workspaces]] — `june_refund_approval_threshold_cents`
- [[../lifecycles/god-mode]] — the Eve cockpit + SMS decision surface
- [[cora-triage-pass]] · [[ticket-analyzer]] — the Cora/June dial-in this landed with
