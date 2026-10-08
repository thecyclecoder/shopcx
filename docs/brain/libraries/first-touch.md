# libraries/first-touch

`markFirstTouch()` — applies `touched` + `ft:{source}` tag. Idempotent — only the first outbound touch matters. Also hosts `shouldDispatchSolFirstTouch()`, the pure predicate the unified handler runs to decide whether a turn starts Sol's first-touch box session.

**File:** `src/lib/first-touch.ts`

## Exports

### `markFirstTouch` — function

```ts
async function markFirstTouch(ticketId: string, source: "ai" | "workflow" | "journey" | "agent",) : Promise<void>
```

### `shouldDispatchSolFirstTouch` — function

```ts
function shouldDispatchSolFirstTouch(input: {
  isNew: boolean;
  solFirstTouchEnabled: boolean;
  agentAssigned: boolean;
  msgType: "account" | "general" | "outreach";
  inheritedActivePlaybook: boolean;
}): boolean
```

The exact § 3.95 Sol first-touch predicate, extracted so it is unit-testable (`first-touch.test.ts`). `true` only when the ticket is new, the channel opted into `sol_first_touch_enabled`, no agent is involved, the classifier bucket is not `outreach`, AND the ticket did NOT inherit a running playbook via auto-merge. The `inheritedActivePlaybook` clause is Phase 1 of [[../specs/playbooks-survive-merge-guard-teasers-watchdog-catches-stalls]] — a merged-in running playbook continues (§ 3b) instead of being first-touched. See [[../lifecycles/ticket-lifecycle]] § Phase 2b.

## Callers

- `src/lib/inngest/unified-ticket-handler.ts`
- `src/lib/journey-delivery.ts`
- `src/lib/portal/handlers/cancel-journey.ts`

## Gotchas

- Idempotent — only the first outbound touch tags ft:*. Subsequent outbound doesn't replace it.

---

[[../README]] · [[../../CLAUDE]]
