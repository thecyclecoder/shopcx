# libraries/completed-effect-backing

Populates the `backed` set the [[claim-guard]] `unbackedEffectClaim` guard reads on the plain-reply paths (`ai_response` / `kb_response`) so a truthful restatement of an effect that ALREADY completed on the ticket is no longer blocked as an unbacked promise. **Phase 1 of [[../specs/claim-guard-backs-completed-effects-on-post-journey-followups]].**

**File:** `src/lib/completed-effect-backing.ts`

## Overview

The [[claim-guard]] is doing important work — it blocks a Sonnet turn from asserting "I've refunded you" or "your subscription has been cancelled" as prose when no verified action backs it (the #1 broken-promise mechanism). But on `ai_response` / `kb_response` the guard was previously handed a **hardcoded empty set**, so any first-person completed-effect assertion was unbacked by construction and escalated — even when the cancellation genuinely completed earlier in the same ticket (a completed cancel journey, or the target subscription already sitting in `status='cancelled'`). Blocking a truthful restatement costs an escalation for nothing.

This helper narrows that failure by populating `backed` from evidence that the effect ALREADY completed, so the guard now distinguishes "we never did this" (still blocks) from "we already did this" (allows). Two evidence sources, both authoritative + read-only:

1. **A completed journey on THIS ticket** — [[../tables/journey_sessions]] row with `status='completed'` for `ticket_id`. The [[../tables/journey_definitions]].`journey_type` maps to a claim-guard action family (e.g. `cancellation` → `cancel`, `pause` → `pause`).
2. **The target subscription already in the claimed end state** — the customer's [[../tables/subscriptions]] row with `status='cancelled'` backs a cancellation claim; `status='paused'` backs a pause claim.

Both queries re-assert `workspace_id` alongside `ticket_id` / `customer_id` so a foreign-workspace row cannot back a claim on this ticket (same enumeration-scope narrowing the sibling [[sol-cta-reference-guard]] `hasLaunchedJourneyThisTurn` applies).

## Fail-safe

Any lookup error or ambiguity → **empty set**. That reproduces today's blocking behavior — the guard still trips, the caller still escalates. This asymmetry is deliberate and lifted straight from the spec's Phase 1 Why: **blocking a true statement costs an escalation; sending a false one costs a customer's trust**, so the failure mode must stay on the blocking side. Never throws.

Pure DB reads + a small deterministic mapping table — no model call. Mirrors the sibling guard style ([[sol-cta-reference-guard]] `hasLaunchedJourneyThisTurn`).

## Coverage

| `journey_type` (completed) | Backed families | Effect it excuses |
|---|---|---|
| `cancellation` | `cancel` | `cancel` claim |
| `pause` | `pause`, `pause_timed`, `crisis_pause` | `pause` claim |
| `product_swap` | `swap_variant` | `swap` claim |
| `return_request` | `create_return` | `return` claim |
| `address_change` | `update_shipping_address` | `address` claim |

| `subscriptions.status` | Backed families | Effect it excuses |
|---|---|---|
| `cancelled` | `cancel` | `cancel` claim |
| `paused` | `pause`, `pause_timed`, `crisis_pause` | `pause` claim |

Families listed here are the SAME strings the `EFFECT_PATTERNS[i].families` array in [[claim-guard]] uses, so the backed set plugs straight into `unbackedEffectClaim`. Adding a new mapping is safe only when a new EFFECT_PATTERN family lands in `src/lib/claim-guard.ts`.

Types not listed (`custom`, `account_linking`, `discount_signup`, `win_back`) don't correspond to a completed-effect claim shape the guard trips on today.

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `backedEffectsForCompletedEffects` | `(ctx: BackedEffectContext) => Promise<Set<string>>` | Reads `journey_sessions` + `subscriptions` for the ticket + customer and returns the union of backed families. Never throws. |
| `BackedEffectContext` | `{ admin, workspace_id, ticket_id, customer_id }` | Admin is the service-role Supabase client — every read follows the [[../../CLAUDE]] "all writes go through createAdminClient()" invariant. |

## Callers

- [[action-executor]] `executeSonnetDecision` — `kb_response` / `ai_response` case: called BEFORE `unbackedEffectClaim(decision.response_message, backed)` on every plain-reply turn. The prior call site passed `new Set<string>()`; the new call site passes this helper's result.

## Tests

`src/lib/completed-effect-backing.test.ts` (`node:test`) — pins the two verification bullets the spec calls out plus the fail-safe:
- Completed cancel journey on the ticket + a cancellation claim → guard allows.
- Same claim with NO completed effect → guard still blocks + caller escalates.
- Subscription already `status='cancelled'` / `status='paused'` backs the matching claim.
- Foreign-workspace journey cannot back a claim on this ticket.
- In-flight journey (status != `completed`) does not back a completion claim.
- DB probe throw returns an EMPTY set (guard reverts to today's blocking behavior).

Registered via `test:completed-effect-backing` in `package.json` (per the [[../operational-rules]] `check:tests-registered` invariant). Run: `npx tsx --test src/lib/completed-effect-backing.test.ts`.

## Provenance

Phase 1 of [[../specs/claim-guard-backs-completed-effects-on-post-journey-followups]] — recovered from parked cs-director job `d7ba0395-27e8-4508-9af4-b4baf4e21fd3` (2026-08-10). Owned by [[../functions/cs]] under the "Escalation triage quality" mandate: an escalation raised because a TRUE statement was mistaken for a false promise is a false positive this mandate owns.
