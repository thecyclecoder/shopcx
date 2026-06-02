# libraries/packing-slip-message

Packing-slip insert message generator for orders.

**File:** `src/lib/packing-slip-message.ts`

## File header

```
Packing-slip "founder note" for Amplifier orders.
Template (Superfoods Co):
"Hey {first_name}, it's Dylan the founder of Superfoods Company.
So glad to have you in the superfoods family. We hope you really
enjoy {this product / these products} and that they help you
reach your goals!"
First-time customers get the template verbatim (a clean first
impression). Repeat customers get a Haiku rewrite — same sender,
same warmth, same length, just a fresh phrasing so the box doesn't
become a copy-paste experience over 12 cycles.
Amplifier rejects Unicode + caps the field at 2000 chars; we strip
non-ASCII and hard-cap at 1800 to leave headroom.
```

## Exports

### `buildPackingSlipMessage` — function

```ts
async function buildPackingSlipMessage(input: BuildPackingSlipInput) : Promise<string>
```

### `BuildPackingSlipInput` — interface

## Callers

- `src/app/api/checkout/route.ts`
- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
