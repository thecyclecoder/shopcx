# libraries/sol-cta-reference-guard

Deterministic pre-send guard that blocks an outbound reply which REFERENCES a call-to-action ("click the button below", "use the link", "click here", "here is your link", "tap the button") when NO journey/CTA was actually LAUNCHED for the ticket in that turn. **Phase 3 of [[../specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]].**

**File:** `src/lib/sol-cta-reference-guard.ts`

## Overview

Two earlier guards already cover their own broken-promise shapes: [[claim-guard]] `unbackedEffectClaim` catches first-person completed-effect assertions ("I've refunded you") on paths that attach no action; [[sol-outcome-claim-guard]] `assessOutcomeClaims` catches unverified required-outcome claims. Neither catches the specific shape this guard targets — a reply that DIRECTS the customer to a CTA that was never actually launched.

The failure this catches:
```
Sure — click the button below to cancel your subscription.
```
… sent as `action_type='ai_response'` (no journey attached, no `journey_sessions` row written this turn). The customer sees no button — the reply is a phantom-CTA lie.

The guard fires when the message contains a CTA-reference phrase AND [[../tables/journey_sessions]] has no row on this ticket at-or-after the turn's start. On block:
- `sysNote` logs the exact matched phrase for operator debugging.
- `escalateTicket(ctx, 'blocked_unbacked_claim:cta_tail')` — the shared [[../inngest/triage-escalations]] `blocked_unbacked_claim:*` selection rule already routes this reason to the `needs_attention` triage lane on the same terms as `blocked_unbacked_claim:cancel` / `blocked_unbacked_claim:refund`.
- The outbound send is SKIPPED — the reply never reaches the customer.

The operator's remediation is one of two outcomes:
1. **Launch the mechanism** (Phase 2's [[sol-direction-apply]] `applySolDirection` on a Direction with `chosen_path='journey'` + a real `plan.journey_slug`); OR
2. **Reword the reply** so it no longer references a CTA that doesn't exist.

## Coverage

The pure detector matches phrases that clearly direct the customer to a clickable surface (verification bullet 3 — no false-positive on incidental phrases):

| Pattern name | Example match |
|---|---|
| `click_the_button_below` | "click the button below" / "click this link below" |
| `click_below` | "click below" |
| `click_the_link` | "click the link" / "click this link" |
| `click_here` | "click here" |
| `tap_the_button` | "tap the button" / "tap the link" |
| `use_the_link` | "use the link" / "use this form" |
| `use_link_below` | "use the link below" |
| `button_below` | "button below" |
| `link_below` | "link below" |
| `follow_the_link` | "follow the link" |
| `here_is_the_link` | "here is your link" / "here is the form" |
| `manage_via_button` | "cancel via the button" / "manage using the link" |

Explicitly does NOT match:
- Incidental noun references ("that button on the fridge", "the link between the two orders")
- Empathetic replies with no CTA directive ("I'm sorry to hear that — let me look into this")
- Empty / null messages

## Exports

### `detectCtaReference` — pure function

```ts
interface CtaReferenceHit {
  matched_phrase: string;
  pattern_name: string;
}
function detectCtaReference(message: string | null | undefined): CtaReferenceHit | null
```

Returns the first matched pattern (with the exact matched phrase for the escalation reason + a stable `pattern_name` for tests / analytics) or `null` when the message has no CTA reference. Deterministic — no I/O.

### `hasLaunchedJourneyThisTurn` — DB probe

```ts
function hasLaunchedJourneyThisTurn(ctx: {
  admin: SupabaseClient;
  workspace_id: string;
  ticket_id: string;
  turn_started_at: string; // ISO
}): Promise<boolean>
```

Returns `true` if [[../tables/journey_sessions]] has a row for this workspace + ticket created at-or-after `turn_started_at`. Re-asserts BOTH scope columns on the probe (learning #7 — narrow the enumeration to the correct scope). Fail-open on a DB probe error (learning #6 — a transient read failure must NOT strand a legit reply).

### `assertCtaBackedByLaunch` — top-level wire-in

```ts
type CtaGuardAssessment =
  | { ok: true }
  | { ok: false; hit: CtaReferenceHit; reason: string };

function assertCtaBackedByLaunch(input: {
  admin: SupabaseClient;
  workspace_id: string;
  ticket_id: string;
  message: string | null | undefined;
  turn_started_at: string;
}): Promise<CtaGuardAssessment>
```

Composed from the two above. `reason` is prefixed `blocked_unbacked_claim:cta_tail` so the shared [[../inngest/triage-escalations]] `blocked_unbacked_claim:*` selection rule routes the escalation to the triage lane without any new match rule.

## Callers

- [[action-executor]] § `executeSonnetDecision` § `case "kb_response" | "ai_response"` — the primary wire-in, right after the existing `unbackedEffectClaim` block. These paths attach no journey, so a CTA reference is unambiguously unbacked (no `journey_sessions` row is written this turn). Wired at [`src/lib/action-executor.ts` — the ai_response / kb_response case block].

## Design invariants (learnings applied)

- **Fail-open on the DB probe** (learning #6) — a probe error returns `true` so a legit reply can't be stranded by a transient DB failure.
- **Workspace + ticket scope re-asserted at the probe** (learning #7) — a foreign-workspace journey session cannot back a claim on this ticket.
- **Pure detector + DB probe split** — the detector is fully testable with no infra; the wire-in is exercised via an in-memory Supabase stub (`sol-cta-reference-guard.test.ts`).
- **Conservative pattern coverage** (verification bullet 3) — patterns require an explicit click/tap/follow/use verb OR a "here is your <surface>" locator; a message that merely uses the noun "button" or "link" in passing doesn't trip.

## Related

- [[claim-guard]] `unbackedEffectClaim` — Phase 0 completed-effect claim guard (companion).
- [[sol-outcome-claim-guard]] `assessOutcomeClaims` — Phase 3 of the false-promises spec (companion, guards unverified outcomes).
- [[sol-direction-apply]] `applySolDirection` — Phase 2 of this spec's parent, launches a real journey so a CTA-reference reply IS backed.
- [[journey-delivery]] `launchJourneyForTicket` — the shared journey launcher, writes the `journey_sessions` row this guard reads.

---

[[../README]] · [[claim-guard]] · [[sol-outcome-claim-guard]] · [[sol-direction-apply]] · [[journey-delivery]] · [[../specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]] · [[../../CLAUDE]]
