# libraries/account-linking-journey-builder

Builds the account-linking prepend step (checklist of candidate emails). Never standalone.

**File:** `src/lib/account-linking-journey-builder.ts`

## File header

```
Account Linking Journey Builder — single source of truth.
Finds unlinked customer profiles and builds a checklist + confirm flow.
```

## Exports

### `buildAccountLinkingSteps` — function

```ts
async function buildAccountLinkingSteps(admin: Admin, workspaceId: string, customerId: string, _ticketId: string,) : Promise<BuiltResult>
```

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
