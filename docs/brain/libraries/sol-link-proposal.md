# libraries/sol-link-proposal

Applies the first-class **link proposal** Sol / June names on their Direction (`plan.link_proposal` — see [[ticket-directions]]) BEFORE the mechanism dispatch fires, so a downstream refund/cancel/journey remedy targets the whole linked person — the `customer_links` group — instead of dead-ending on the empty half. **Phase 2 of [[../specs/account-linking-address-aware-confidence-graded-and-cs-searchable]].**

**File:** `src/lib/sol-link-proposal.ts` · **Tests:** `src/lib/sol-link-proposal.test.ts` (7 cases)

## Overview

`account-matching.gradeUnlinkedCandidates` (Phase 1) already surfaces HIGH-confidence unlinked siblings on every read of the customer account (⚠️ block in [[sonnet-orchestrator-v2]] `get_customer_account`) and via the read-only `get_link_candidates` tool. Phase 2 makes the LINK ACTION a first-class field on Sol's Direction (`plan.link_proposal`) that the box worker's ticket-handle job executes as step (0) of the mechanism-dispatch try block:

```
[Sol writes Direction] → writeDirection (validator gates link_proposal)
                       → applySolLinkProposal (upserts customer_links, clears stale rejection)
                       → resolveSolChosenJourney / journey / workflow / stateless send
```

The applier is authorised by two independently-verifiable predicates and refuses on any of the following:

| result reason                    | when                                                                                          |
|---------------------------------|-----------------------------------------------------------------------------------------------|
| `linked`                         | HIGH-confidence, no prior rejection — the customer_links group is created/joined.             |
| `reconfirmed`                    | HIGH + `previously_rejected: true` + `reconfirmed: true` — linked AND the stale rejection row is cleared. |
| `already_linked`                 | Pair already in one group — idempotent no-op (still clears rejection on a re-confirm).        |
| `low_confidence_skipped`         | `confidence !== 'high'` — surface-only for June's judgement, never auto-linked.               |
| `needs_reconfirm`                | `previously_rejected: true` without `reconfirmed: true` — refused (the NEVER-silent-auto-link guard). |
| `same_customer`                  | Candidate equals the ticket's own customer — refused.                                          |
| `candidate_not_in_workspace`     | Candidate exists in a different workspace — refused (workspace scope re-asserted).             |
| `candidate_missing`              | Empty/whitespace `candidate_customer_id` — refused.                                            |

## Guards (why the shape is what it is)

1. **Two independent authorisations.** `confidence: "high"` (Phase 1's grade — address/phone corroborated) AND (`!previously_rejected` OR `reconfirmed: true`). Either gate closed → no link. Learning #9 pattern: the confirming predicate at the action point, not a coarser proxy.
2. **Idempotent.** A repeat call on an already-linked pair returns `already_linked` without a duplicate `customer_links` row. On a re-confirm the stale `customer_link_rejections` row is deleted so a future weak matcher can't reintroduce the ghost rejection.
3. **Workspace-scoped.** The candidate customer must exist in the ticket's workspace; a cross-workspace id never authorises the link (mirrors the playbook/journey slug guard in [[ticket-directions]]).
4. **Same-customer refused.** A Direction that "links a customer to themselves" is a nonsense write refused both at the writer ([[ticket-directions]] `link_proposal_same_customer`) and here.
5. **Audit trail.** An `outbound` + `internal` + `system` note is stamped on the ticket with the confidence + signals + reason + re-confirm marker, so the human reviewer can retrace Sol/June's cited evidence in one place.

## Callers

- `scripts/builder-worker.ts` — `runTicketHandleJob` mechanism-dispatch try block, step (0) before journey/workflow/stateless send.
- Future: `cs-director-call` verdict lane (June's `approve_remedy` batch that leads with `link_customer_accounts`) — the applier remains the deterministic execution primitive.

## Related

[[account-matching]] · [[ticket-directions]] · [[sol-direction-apply]] · [[../specs/account-linking-address-aware-confidence-graded-and-cs-searchable]] · [[../tables/customer_links]] · [[../tables/customer_link_rejections]]

---

[[../README]] · [[../../CLAUDE]]
