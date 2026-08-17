# libraries/escalation-recheck

SDK for the typed, machine-checkable "what would retire this card" descriptor a condition-based CEO escalation carries on its `dashboard_notifications.metadata.retire_when` jsonb slot. Phase 1 of [[../specs/an-escalation-retires-itself-when-the-condition-it-reported-self-heals]].

**File:** `src/lib/escalation-recheck.ts`

## The problem it solves

An escalation card is a photograph of one bad moment, and until this SDK shipped it kept claiming that moment was still true forever. On 2026-08-14 two CEO cards were raised at 17:40 (`a5376176` + `6c8ef178`, `create_subscription — no_vaulted_payment_method` against ticket `2c49bc7e`). The system linked the customer's accounts by 22:51, changed her cadence at 23:34, corrected the billing date at 05:57 on 08-15, and closed the ticket resolved at 05:57:41. The cards sat 67 hours describing a failure that no longer existed. A card that outlives its cause spends founder attention on nothing.

The full fix is two phases; this SDK is Phase 1. Phase 2 (a standing sweep that reads the descriptor and retires healed cards) consumes this SDK.

## The closed union

`EscalationRecheckDescriptor` is `{kind, ...params}` — mirrors [[spec-phase-checks-table]]'s `{exec_kind, params}` shape for spec verification checks so the sweep's execution surface stays small and unit-testable.

- **`ticket_terminal`** — `{ ticket_id }`. Retire when the linked ticket reached `status='closed'` and is not escalated. The founder-escalation class ([[cs-director-escalate-founder-card]] `buildEscalateFounderCard`) and the cs-director-loop-guard class ([[agents/needs-attention-route-cs-owner]]) both carry this shape.
- **`job_terminal`** — `{ agent_job_id }`. Retire when the parked `agent_jobs` row is no longer in a live / needs-attention status. For a card fronting a parked job (a build stuck, a groom unsure) — once the job left needs_attention (completed / escorted / force-cleared), the card describes state that no longer exists.
- **`action_satisfied`** — `{ action, customer_id }` where `action ∈ { 'subscription_exists', 'order_exists' }`. Retire when the thing the failed action was trying to create now exists. The assisted-purchase-failure class ([[assisted-purchase-failure-card]] `buildAssistedPurchaseFailureCard`) carries this — the 2026-08-14 ground-truth pair is exactly this shape (Susan's subscription eventually existed → the card describes a healed condition).
- **`non_retirable`** — `{ reason }`. Never retire. Decision-class escalations (a founder yes/no — e.g. a storefront-campaign proposal) explicitly opt out of the sweep. The `reason` string is a short human note surfaced in the audit trail.

Add another shape ONLY when a real card needs one; the sweep's execution surface should stay exactly the set of things the inbox actually raises. The spec's guidance from Phase 1: "derived from the live inbox rather than guessed."

## Exports

- **`EscalationRecheckDescriptor`** — the discriminated union of the four shapes above (`TicketTerminalRecheck` | `JobTerminalRecheck` | `ActionSatisfiedRecheck` | `NonRetirableRecheck`).
- **`validateEscalationRecheckDescriptor(input)`** → `{ valid: true; value } | { valid: false; reason }` — validates an arbitrary jsonb value against the closed union. Used by the raise-path helpers ([[agents/platform-director]] `escalateDiagnosisToCeo` / `escalateApprovalRequestToCeo`) at write time — a malformed value is rejected + logged, and the card is minted WITHOUT the descriptor rather than fail-open with a corrupt one.
- **`readEscalationRecheckDescriptor(metadata)`** → `EscalationRecheckDescriptor | null` — reads `metadata.retire_when` and validates. Returns `null` when the row carries no descriptor OR its descriptor is malformed. The Phase-2 sweep uses this and treats `null` as non-retirable (fail-closed).
- **`isRetirable(descriptor)`** → `boolean` — fail-closed helper: `null` and `non_retirable` both return `false`; every other well-formed descriptor returns `true`. Absence and explicit non-retirable behave IDENTICALLY for the sweep; the distinction is only in the audit trail (`non_retirable.reason` documents the intent).

## Contract: absence defaults to NON-RETIRABLE

An un-migrated raiser (a legacy code path, an inline `.from('dashboard_notifications').insert(...)` that doesn't know about this SDK, an unfamiliar `escalationKind`) MUST NOT have its card auto-cleared. The reader enforces this: no descriptor → `null` → `isRetirable(null) === false` → the sweep leaves it. The same rule applies to a malformed descriptor (validation fails → reader returns `null` → non-retirable).

This is the SAFE-CLOSED direction the spec pins ("an un-migrated or unfamiliar raiser can never have its card auto-cleared"). A wrong-conservative outcome (a card sits a little longer than it strictly had to) is always preferable to a wrong-aggressive one (a card retires while the underlying condition is still true and the founder never sees the live problem).

## Callers today (Phase 1)

- [[agents/platform-director]] `escalateDiagnosisToCeo` — accepts an optional `retireWhen` arg; a caller that knows the healing condition (a ticket_id, an agent_job_id) passes the descriptor. The `cs_director_loop_guard` escalation in [[agents/needs-attention-route-cs-owner]] passes `{ kind: 'ticket_terminal', ticket_id }`.
- [[agents/platform-director]] `escalateApprovalRequestToCeo` — same optional arg, same validation.
- [[cs-director-escalate-founder-card]] `buildEscalateFounderCard` — pure builder; carries `{ kind: 'ticket_terminal', ticket_id }` UNCONDITIONALLY on the card's metadata since `ticket_id` is a load-bearing input to every founder escalation.
- [[assisted-purchase-failure-card]] `buildAssistedPurchaseFailureCard` — pure builder; carries `{ kind: 'action_satisfied', action, customer_id }` unconditionally. The ground-truth 2026-08-14 shape.

## Phase 2 sweep — `retireHealedEscalations`

The Phase-2 standing sweep lives in **[[escalation-retirement-sweep]]** (`src/lib/escalation-retirement-sweep.ts`) and is called once per pass from `runPlatformDirectorStandingPass` in `scripts/builder-worker.ts`, alongside `reconcileSwallowedEscalations` and the rest of the standing-pass family. It:

1. Builds the approvals feed via [[agents/approvals-feed]] `buildApprovalsFeed` and filters to `source==='pending' && escalated` — the sweep evaluates EXACTLY the set the founder sees.
2. For each card: `isRetirable(readEscalationRecheckDescriptor(metadata))` — absent, malformed, or `non_retirable` descriptors are LEFT alone.
3. Reads the descriptor's needed current state per shape (`ticket_terminal` → `tickets.status`; `job_terminal` → `agent_jobs.status`; `action_satisfied.subscription_exists` → any active subscription; `action_satisfied.order_exists` → any order).
4. Calls the pure `decideRetirement(descriptor, state)` helper — retires ONLY on positive proof of healing. Any unreadable field leaves the card exactly where it is (fail-closed).
5. Dismisses the notification (`dismissed=true`) with metadata patch — `retire_reason`, `retire_evidence`, `retired_at` — so a founder can audit "what did it retire, and was it right?" from the row alone.
6. Writes ONE [[../tables/director_activity]] row with `action_kind='retired_escalation'` under the RAISING director's function (read from `metadata.escalated_by_director`, defaulting to `platform`).
7. Bounded by `RETIREMENT_SWEEP_CAP_PER_PASS` (50); the standing-pass note names the retired cards (`retirement sweep → dismissed N healed card(s): …`) so a burst is visible.

The `decideRetirement` helper is pure and unit-tested in `escalation-retirement-sweep.test.ts` (7 tests exercising each shape + the fail-closed contract).

## Related

- [[../tables/dashboard_notifications]] — the row this descriptor rides on. No migration: `metadata` is already `jsonb DEFAULT '{}'`.
- [[../specs/an-escalation-retires-itself-when-the-condition-it-reported-self-heals]] — the full spec (Phase 1 SDK + Phase 2 sweep).
- [[agents/approvals-feed]] `buildApprovalsFeed` — the reader the Phase-2 sweep filters to `source==='pending' && escalated` so it evaluates EXACTLY the set the founder sees.
- [[escalation-retirement-sweep]] — the Phase-2 sweep + pure `decideRetirement` helper.
- [[spec-phase-checks-table]] — the sibling `{kind, params}` closed union this descriptor's shape mirrors.
