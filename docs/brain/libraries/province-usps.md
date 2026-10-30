# libraries/province-usps

**Status:** Province/state normalization for shipping addresses. Resolves full US state names, US territories, and Canadian province names to their correct 2-letter USPS/ISO 3166-2 codes, mirroring the country normalization in `src/lib/country-iso2.ts`.

**Incident:** Ticket 84a8104a (Chanen Cross, contract 28153413805) — a portal reactivate attempt failed with "Delivery method shipping address zip is invalid" because the stored province was a full name ("Nevada") and the old `province.toUpperCase().slice(0,2)` derivation produced a valid-but-WRONG code ("NE" = Nebraska) instead of the correct USPS code ("NV"). Replacements, new orders, and other shipment destinations were silently corrupted for every customer whose stored province was a full name with a colliding 2-letter prefix. The fix adds a proper state/province name→code map and routes all province normalization through it.

**File:** `src/lib/province-usps.ts`

## Exports

### `normalizeProvinceToCode(input)` — function

```ts
export function normalizeProvinceToCode(input: string | null | undefined): string
```

Normalize a state/province identifier to its 2-letter USPS/ISO 3166-2 code.

**Behavior:**
- Full US state name (`"Nevada"`) → correct USPS code (`"NV"`), **never** a sliced prefix collision (`"NE"`).
- Full Canadian province name (`"Ontario"`) → ISO 3166-2 code (`"ON"`).
- Already-valid 2-letter code (`"WA"`, `"ca"`) → passed through uppercased.
- Unknown / non-US-CA value (a foreign subdivision like `"Bavaria"`) → the trimmed input returned unsliced, so we never emit a wrong 2-char guess that Shopify would accept but misroute.
- Empty/missing input → `""`.

**Critical invariant:** unknown values are returned **unsliced**. The old bug was that a naive `province.toUpperCase().slice(0,2)` on an unknown full name produces a plausible but incorrect 2-letter token that Shopify accepts but routes to the wrong jurisdiction. This helper rejects that pattern entirely — if we don't have a mapping, we pass the unsliced value upstream so the handler can detect it and escalate rather than silently shipping to the wrong place.

**Maps:** US states (50 + DC), US territories (PR, GU, VI, AS, MP, AA, AE, AP), Canadian provinces and territories (13).

## Coverage

### Test coverage (customer-shipping-address.test.ts)

- **Collision cases:** Nevada→NV (not NE/Nebraska), Montana→MT (not MO/Missouri), Alaska→AK (not AL/Alabama), Maine→ME, Maryland→MD, Massachusetts→MA, Michigan→MI, Minnesota→MN, Mississippi→MS, Missouri→MO.
- **2-letter pass-through:** Already-valid codes like `"WA"` and lowercase variants like `"ca"` pass through uppercased.
- **Canadian names:** Ontario→ON, Quebec→QC.
- **Unknown/non-US-CA:** Foreign provinces like `"Bavaria"` are returned unsliced, never as a 2-char guess.

## Callers

- `src/lib/customer-shipping-address.ts` — `normalizeAddress()` calls it to derive `provinceCode` from the raw `province` field, replacing the old naive slice (line 127).

## Gotchas

- **Unknown values must stay unsliced.** A foreign subdivision like `"Bavaria"` MUST return `"Bavaria"` (unsliced), never a 2-char guess like `"BA"`. The ticket 84a8104a defect was that the naive slice produced plausible-but-wrong codes; returning the unsliced value forces the handler to detect and escalate the unmapped case.

- **Collision cases are pinned.** The nine tested collision cases (Nevada→NV not NE, Montana→MT not MO, etc.) cover all prefix collisions in the US/CA state set. Any future additions to the state map must preserve these exact mappings.

- **Territory and DC handling.** Shopify encodes Puerto Rico, Guam, Virgin Islands, American Samoa, and Northern Mariana Islands as country="US" with the territory code in the province field (mirrors how `src/lib/country-iso2.ts` handles territories). Armed Forces postal codes (AA, AE, AP) are included.

---

[[../libraries/customer-shipping-address]] · [[../README]] · [[../../CLAUDE]]
