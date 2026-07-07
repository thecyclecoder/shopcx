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
Amplifier rejects Unicode + silently truncates the packing-slip
field somewhere around 225-250 chars; we strip non-ASCII and
hard-cap at 225 so the note is never cut mid-sentence on the box.
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

- **225-char ceiling (Amplifier truncates past ~225-250).** `MAX_CHARS = 225`.
  Three layers enforce it: (1) the templates land at ~180-217 for realistic
  names; (2) the Haiku paraphrase for repeat customers is instructed to stay
  150-210 chars and is *rejected* — falling back to the short template — if the
  rewrite exceeds 225 post-ASCII-strip; (3) `capToLimit` does a graceful
  word-boundary cap as a backstop for pathological (30+ char) first names.
  [[integrations__amplifier]] applies the same 225 cap at the API boundary.
- **ASCII only.** `asciiOnly` strips emoji / em-dashes / curly quotes / accents
  (Amplifier rejects non-ASCII) and collapses the double-space left behind.
- **Haiku rewrite fails open.** Any timeout / missing key / wrong-name /
  wrong-count / too-long rewrite returns the verbatim template — a bad
  paraphrase never blocks fulfillment.

---

[[../README]] · [[../../CLAUDE]]
