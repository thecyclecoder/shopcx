# libraries/ad-validator

Ad tool — the **refuse-to-ship gate**. Direct-response validator with no "are you sure" override: an ad that fails never ships. Called by the script generator (Phase 3, up to 3 retries) AND again as a hard pre-encode gate at render time (Phase 5).

**File:** `src/lib/ad-validator.ts` · See [[ad-script]], [[ad-render]], [[ad-tool-config]], [[ad-angles]].

## Exports

### `validateAdScript` — function

```ts
function validateAdScript(
  script: string,
  angle: Pick<ProductAdAngle, "meta_headline"|"meta_primary_text"|"meta_description"|"proof_anchor"> | null,
  inputs: AngleGeneratorInput,
  opts?: { bannedWords?: string[] },
): { ok: boolean; violations: Violation[] }
// Violation = { code, severity: "fatal"|"warn", message }
```

### `validateAngle` — function

```ts
function validateAngle(angle: ProductAdAngle, inputs: AngleGeneratorInput): ValidationResult
```

Verbatim-anchor check on `lead_benefit_anchor` (must be a `benefit_bar[].text` or `lead_benefits[].name`) plus the three Meta caps. Used by the generator before insert.

### `estimateSpokenSeconds` — function

```ts
function estimateSpokenSeconds(script: string): number  // ≈ words / 2.6 wps
```

## Violation codes

| Code | Meaning |
|---|---|
| `warm_opener` | First word ∈ `BANNED_OPENERS` (hey/hi/hello/welcome/introducing) |
| `brand_first_opener` | Opener leads with the product/brand name |
| `feature_led_opener` | Ingredient/sourcing/cert term in the first ~5 spoken seconds |
| `banned_word` | Soft word (supports, helps, natural, boost…) anywhere |
| `soft_cta` | "learn more" / "check it out" etc. instead of imperative + urgency |
| `too_long` | Estimated spoken length > `MAX_SPOKEN_SECONDS` (30s) |
| `unanchored_claim` | A product-claim sentence whose keywords don't trace to a tier-1/2/3 anchor (≥34% overlap) |
| `review_as_promise` | Central promise rests on a cited review with no tier-1/2 anchor |
| `anchor_not_verbatim` | (angle) `lead_benefit_anchor` not a verbatim benefit |
| `meta_headline_overflow` / `meta_primary_overflow` / `meta_description_overflow` | Meta copy over caps (40 / 125 / 30) |

## Callers

- `src/lib/ad-script.ts` — `validateAdScript` after each generation attempt (3 retries)
- `src/lib/ad-angles.ts` — `validateAngle` before insert
- `src/app/api/ads/validate/route.ts` — on-demand operator validation
- `scripts/test-ad-validator.ts` — test harness

## Gotchas

- **Only PRODUCT-CLAIM sentences need anchoring.** A sentence requires anchoring only if it names the product OR uses a solution verb (gives/delivers/crushes/ends…). Pure problem/agitation framing about the category ("most coffee spikes you then drops you") is exempt by design.
- **Cited reviews can back, never lead.** A review quote (`"Real customer: '…'"`) is allowed as support, but if nothing else anchors, `review_as_promise` fires.
- Anchoring is keyword-overlap heuristic (stopword-light, ≥34% of a claim's content keywords must appear in an anchor phrase) — not semantic. Tune `anchorPhrases`/`STOP` if it gets noisy.
- `severity:"warn"` violations don't flip `ok` to false — only `fatal` do. Currently every emitted violation is fatal.

---

[[../README]] · [[../../CLAUDE]]
