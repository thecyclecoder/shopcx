# email-typo — deterministic mistyped-email detector

`src/lib/email-typo.ts` — dependency-free detection + correction of mistyped consumer email addresses (the mailcheck algorithm). No external service, no network call, pure + deterministic.

## Why

A customer who signs up as `dylanralston@gmaik.com` creates an account we can **never reach** — every reply, journey CTA, and magic link bounces into the void, and it silently spawns a duplicate of their real account. This flags the likely typo so a CX agent can confirm the real address before relying on it.

**A suggestion is NOT permission to mutate.** The caller (a confidence-gated agent) decides whether to confirm with the customer, auto-correct only when corroborated (matches an existing account / order / name), or route to account linking when the corrected address matches an existing account. It never rewrites an address into one that belongs to a **different** live customer except as a deliberate link.

## Exports

```typescript
suggestEmailCorrection(input: string) → EmailTypoSuggestion
looksMistyped(input: string) → boolean   // convenience: any non-'none' suggestion
```

`EmailTypoSuggestion`:
- `normalized` — input trimmed + lowercased
- `corrected` — suggested fix, or `null`
- `changed` — did we find a plausible correction?
- `confidence` — `"high"` (single edit toward a common domain — auto-correct when corroborated) · `"likely"` (2 edits — confirm with customer) · `"none"`
- `reason` — `exact_domain` | `tld_fix` | `domain_distance` | `malformed` | `none`

## How it decides

1. **Known-good domain** (`gmail.com`, `yahoo.com`, … ~23 common consumer domains) → never corrected (`exact_domain`).
2. **TLD-only fix** — SLD is fine, TLD is a known typo (`gmail.con → gmail.com`). High confidence when the fixed domain is itself common (`tld_fix`).
3. **Whole-domain edit distance** to a common domain (`gmaik.com → gmail.com`, `gmial → gmail`), Damerau-Levenshtein (transposition-aware). Distance 1 → `high`; distance 2 → `likely` only when the SLD is long enough (≥5) that 2 edits is still a strong signal (avoids false positives on short domains); otherwise `none`. Legit niche domains that merely look similar (`gmailx.com`) are not rewritten.

## Callers

- [[cx-agent-sdk]] `formatCxCustomer` — surfaces `⚠️ EMAIL LIKELY MISTYPED …` on the shared CUSTOMER line, so **Sol, Cora, and June** ([[../functions/ticket-handler]] / [[../functions/ticket-analyzer]] / [[../functions/cs]]) all see it from one wiring point. See [[cx-agent-sdk]] § Formatters.

## Tests

`src/lib/email-typo.test.ts` (node:test) — known-good left alone, single-edit → high, TLD fixes, malformed → none, normalization, no-force-correct on legit niche domains, short-SLD distance-2 not trusted. `src/lib/cx-agent-sdk.test.ts` pins the `formatCxCustomer` wiring (flag surfaces for a typo, absent for a good address).
