# libraries/sol-direction-apply

Deterministic apply path Sol's cheap-execution turn uses to **APPLY** the mechanism named on the live [[../tables/ticket_directions|Direction]] — `launchJourneyForTicket` for a journey, `startPlaybook`+`executePlaybookStep` for a fresh playbook — instead of paying for a Sonnet turn that would otherwise compose a freeform "click below" reply. **Phase 2 of [[../specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]].**

**File:** `src/lib/sol-direction-apply.ts`

## Overview

On every follow-up turn, [[../inngest/unified-ticket-handler]] loads the live Direction and — when `chosen_path` is `journey` or a fresh `playbook` (no `active_playbook_id` yet) — dispatches through `applySolDirection` BEFORE the Sonnet orchestrator. The apply path is:

- **`chosen_path='journey'`** → resolve `plan.journey_slug` against [[../tables/journey_definitions]] (workspace-scoped, `is_active=true`), generate a message-aware `leadIn` via `generateJourneyLeadIn` (mirrors the customer's incoming message, plain text, ≤2 sentences/para per [[../customer-voice]]), then call `launchJourneyForTicket` — the same effector [[action-executor]] uses when Sonnet decides `action_type='journey'`. The customer receives a real token-authed CTA (a `journey_deliveries` row); the turn never sends a prose "click below" reply.

- **`chosen_path='playbook'`** (with `active_playbook_id IS NULL`) → resolve `plan.playbook_slug` against [[../tables/playbooks]] (workspace-scoped, `is_active=true`), call `startPlaybook(seed_context=plan.playbook_seed_context)`, then run one `executePlaybookStep` for the first turn's reply. A follow-up turn on an already-running playbook is owned by [[../inngest/unified-ticket-handler]] § 3.98 `sol-playbook-shortcircuit`; this apply path only kicks off the FIRST step.

- **`chosen_path='stateless'` / `chosen_path='needs_info'`** → not applicable; fall through to the Sonnet orchestrator (no Direction-apply short-circuit).

## Self-service backstop (verification bullet 3)

If the live Direction is `chosen_path='playbook'` AND `isSelfServiceOnlyIntent(rules, direction.intent)` returns true AND a matching active journey exists for the same intent (`journey_definitions.trigger_intent == direction.intent`, workspace-scoped, `is_active=true`), the apply path **overrides** to journey. Deterministic — no LLM in the loop:

A rule is "self-service only" for an intent when EITHER:
- The rule's `category === 'self_service_only'` AND the rule's `content` mentions the intent slug (or its space-separated surface form — a rule authored as `"cancel subscription"` matches `cancel_subscription`); OR
- The `content` contains a "never `<verb>` for [the] customer" clause AND mentions the intent (the natural-language phrasing operators write in [[../tables/sonnet_prompts]]).

This is the deterministic version of the natural-language "never cancel FOR the customer" rule — a direct-mutation playbook can never run on the customer's behalf when a matching self-service journey exists. If no matching journey exists, the playbook path still runs — the rule is a preference, not a hard block that leaves the customer hanging.

The override is stamped on the ticket log:
```
[System] Sol Direction override: self-service-only rule matched intent='cancel_subscription' — routing to journey 'cancel_subscription' instead of playbook 'cancel_for_customer'.
```

## Exports

### `applySolDirection` — function

```ts
async function applySolDirection(
  direction: TicketDirection,
  deps: SolApplyDeps,
): Promise<SolApplyResult>
```

Applies the mechanism named on the Direction and returns a `SolApplyResult` verdict:

```ts
interface SolApplyResult {
  applied: boolean;
  kind: "journey" | "playbook" | "none";
  slug: string | null;
  reason:
    | "journey_launched"
    | "self_service_overrode_playbook"
    | "playbook_started"
    | "no_journey_slug"
    | "journey_not_found"
    | "journey_launch_failed"
    | "no_playbook_slug"
    | "playbook_not_found"
    | "playbook_already_active"
    | "not_applicable_path"
    | "direction_superseded";
  override?: "self_service" | null;
}
```

`applied=true` means the caller SKIPS the Sonnet orchestrator for this turn; `applied=false` means the caller falls through to Sonnet (with the reason stamped on the log for diagnostics).

**Deps** — the caller injects the effect functions the module needs so unit tests exercise branch decisions with pure stubs:
- `admin` — service-role client
- `workspaceId`, `ticketId`, `customerId`, `channel`, `message`, `personality`, `sandbox`
- `send(msg, sandbox)` — mirrors `sendWithDelay`
- `sysNote(m)` — stamps a `ticket_messages` system note
- `generateLeadIn(msg, journeyName, ch, p)` — the message-aware leadIn generator (in production: `generateJourneyLeadIn` from [[../inngest/unified-ticket-handler]])
- `launchJourney(args)` — `launchJourneyForTicket` from [[journey-delivery]]
- `startPlaybookFn(admin, ticketId, playbookId, opts?)` — `startPlaybook` from [[playbook-executor]]
- `executePlaybookStepFn(workspaceId, ticketId, msg, personality)` — `executePlaybookStep` from [[playbook-executor]]
- `loadRules(admin, workspaceId)` — reads active [[../tables/sonnet_prompts]] rows (in production: composed on top of [[cx-agent-sdk]] `getCxPolicies`)

### `isSelfServiceOnlyIntent` — function

```ts
function isSelfServiceOnlyIntent(rules: SolApplyRule[], intent: string): boolean
```

Pure deterministic scan for the self-service-only backstop above. Read-only over the rules array — safe to unit test with a plain literal.

## Guards (learning #6 — confirming predicate at the action point)

- `direction.superseded_at IS NULL` re-asserted at apply time — a racing supersede between the caller's load and this apply cannot authorize a stale mechanism.
- `chosen_path` narrowed to `journey`/`playbook` explicitly; other paths return `not_applicable_path` for the caller to fall through.
- Journey / playbook lookups gate on `is_active=true` — a slug that was deactivated after the Direction was written won't fire (returns `journey_not_found` / `playbook_not_found`).
- Playbook apply re-asserts `tickets.active_playbook_id IS NULL` — a concurrent follow-up turn has already claimed the ticket → return `playbook_already_active` and let § 3.98's shortcircuit handle it.
- Self-service override runs a workspace-scoped lookup for the matching journey; a cross-workspace slug collision cannot leak in.

## Callers

- [[../inngest/unified-ticket-handler]] § 3.99 `sol-direction-apply-check` + `sol-direction-apply-execute` — the deterministic Direction-apply step, positioned AFTER § 3.98's follow-up-turn shortcircuit and BEFORE the Sonnet orchestrator. Stages a `ticket_resolution_events` row with `reasoning='sol:direction-apply:{path}:{slug}'` + CAS `shipped_at` (same stage-then-CAS shape `sendFirstTouchAck` uses) so cost analytics can count Direction-applied turns.

## Related

- [[ticket-directions]] — the SDK that writes / reads the Direction. Phase 1 of the parent spec added `chosen_path='journey'` + `plan.journey_slug` and the writer's `is_active=true` gate on the slug lookup — an unknown slug bails there, not at apply time.
- [[cx-agent-sdk]] `listActionableOutcomes` — the deterministic catalog reader Sol's first-touch box session consults to name the specific matched mechanism on the Direction.
- [[journey-delivery]] `launchJourneyForTicket` — the shared journey-launch effector.
- [[playbook-executor]] `startPlaybook` + `executePlaybookStep` — the shared playbook-start effectors.
- [[../inngest/unified-ticket-handler]] § 3.98 `sol-playbook-shortcircuit` — the follow-up-turn shortcircuit; composes with Phase 2's fresh-start apply (§ 3.99).

---

[[../README]] · [[ticket-directions]] · [[journey-delivery]] · [[playbook-executor]] · [[cx-agent-sdk]] · [[../specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]] · [[../../CLAUDE]]
