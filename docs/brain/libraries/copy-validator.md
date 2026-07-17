# `src/lib/ads/copy-validator.ts`

The **single source of truth** for the six deterministic safety rails Dahlia's author box-session and Max's independent copy-QC both check before a Meta caption ships. Pure, side-effect-free, and typed — the SSOT pattern [[lf8]] already applied for the LF8 gate, extended to five more rails that were previously reimplemented on individual call sites.

Kept in ONE place so the author's self-check and the QC's pre-check cannot drift — a divergence would let Dahlia publish copy Max immediately re-flags as unsafe, or (worse) let a safety miss slip past both. Boolean rails only — no rubric — so it cannot Goodhart.

## API

```ts
validateGeneratedCopy(
  copy: { headline: string; primaryText: string; description: string },
  brief: CreativeBrief,
  context: { audience_temperature: "cold" | "warm" | "hot" | null; competitorAdvertisers: string[]; ourBrand: string },
) → { pass: boolean; checks: Array<{ rail; pass; reason?; evidence? }> }
```

`pass` is `checks.every(c => c.pass)`. Every check reports one rail's verdict, a short `reason` when it fails, and (when relevant) the offending substring in `evidence`. The `brief` parameter is threaded through unused in Phase 1 so future rails that need to cross-reference the brief's proof stack don't force a signature change on either Phase-2 call site.

## The six rails (fixed order)

| # | Rail | What it checks | SSOT reuse |
|---|---|---|---|
| 1 | `lf8` | `hasAnyLf8((headline + " " + primaryText).toLowerCase())` — headline+primary carries at least one Life-Force-8 keyword | [[lf8]] `hasAnyLf8` + `LF8_KEYWORDS` |
| 2 | `meta_caps` | Each field within Meta's caption caps (headline ≤ 40, primary_text ≤ 600, description ≤ 90) | [[ad-tool-config]] `META_CAPS` |
| 3 | `no_msrp` | No bare `$N` in any field UNLESS the same field carries `~~` (strikethrough) or a `per serving` / `per cup` / `per pouch` phrase | inline regex — same rule as `buildMetaCopy`'s MSRP guard |
| 4 | `no_competitor_leak` | For each token from `context.competitorAdvertisers` (≥3 chars, less the product-name allowlist), the token must NOT appear as a whole word in any field | mirrors debrand.ts `PRODUCT_NAME_ALLOWLIST` + word-boundary rule |
| 5 | `cold_offer_gate` | When `context.audience_temperature === "cold"`, delegates to `hasColdOfferLeak(copy)` — otherwise `pass: true` (warm/hot/null untouched) | [[lf8]] `hasColdOfferLeak` + `COLD_OFFER_TOKENS` (shipped by the M1 `dahlia-audience-temperature-marking-and-cold-offer-gate` spec) |
| 6 | `single_promise` | `headline + primaryText` matches at most ONE unique promise substring across a small compiled regex list (`lose N lbs`, `boosts X`, `more X`, `fixes X`) | inline promise patterns |

Rails run in the listed order and every rail always runs — so a fail in rail 1 doesn't short-circuit the rest, and `checks[]` always carries six entries. Consumers can key on `rail` to render a per-rail badge instead of a bare `pass: false`.

## Consumers (wired in Phase 2 — not yet)

- [[creative-agent]] `stockProduct` author-mode branch calls `validateGeneratedCopy` after parsing Dahlia's verdict; a `pass: false` result triggers a copy-only revise via the same `MAX_COPY_AUTHOR_REVISE_ATTEMPTS` retry cap the M1 keystone already owns; on exhaustion escalates via the existing `dahlia_copy_author_exhausted` `director_activity` kind with `metadata.validator_misses = failing checks[]`.
- [[creative-qa]] `runQaCreativeCopyViaBoxSession` pre-computes `validateGeneratedCopy` before dispatching Max, and hands the `{pass, checks[]}` to Max as TRUSTED CONTEXT via a `.claude/skills/max-copy-qc/SKILL.md` prompt block (outside the untrusted DATA fence — same sanitize/delimit pattern [[creative-qc-sandbox]] documents). Max still forms his own persuasion judgment; the shared validator only feeds him the safety-rail truth (persuasion stays in the rubric, safety stays deterministic).

## Tests

`src/lib/ads/copy-validator.test.ts` — every rail's pass and fail cases, the fixed rail order, the `pass = checks.every(...)` invariant, and the two allowlist-style carveouts (`~~$29~~` strikethrough / `$1 per serving` per-unit / `Ritual Coffee` product-name token). Runs via `npm run test:copy-validator`.

## Related

[[lf8]] · [[ad-tool-config]] · [[creative-brief]] · [[creative-agent]] · [[creative-qa]] · [[creative-qc-sandbox]] · [[../specs/dahlia-shared-deterministic-copy-validator]]
