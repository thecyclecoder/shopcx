# `src/lib/ads/creative-side-by-side.ts`

The **side-by-side QC gate** for Dahlia's overlay render path
(dahlia-competitor-ad-adaptation-overlay-render Phase 4). The prime directive in
[[../reference/competitor-ad-adaptation]] is:

> "Adapt against a live side-by-side of the competitor ad, never in isolation. Without it you
> drift toward YOUR graphic and quietly lose the very things that made theirs convert."

So an adapted creative doesn't LAND until it renders beside the competitor skeleton and a
vision judge grades it on two axes:
- **Energy match-or-surpass** — the adaptation ties or wins on visual energy (contrast,
  hierarchy, scroll-stop).
- **Structure preserved** — the imitation still carries every beat in the proven psychological
  structure: `hook → regret → benefit_stack → social_proof_payoff → risk_reversal`.

## Exports

- **`SIDE_BY_SIDE_QC_STRUCTURE`** — the 5-beat enum verbatim (grep-token for the qc-gate verification). The source of truth for the vision judge's structure axis + the outer regen loop's `missing beats` reason string.
- **`SideBySideStructureBeat`** — TS union of the enum values (`"hook" | "regret" | ...`).
- **`SideBySideOpts`** — `outputMime` (jpeg default / png), `dividerPx` (default 8), `dividerColor` (default `#ffffff`), and `ratio` (default `4:5`).
- **`buildSideBySide(competitorImage, adaptedImage, opts?) → { buffer, mimeType }`** — pure sharp composite: `[competitor | divider | ours]`. Both halves are `fit: "contain"` letterboxed (never cropped) to the same per-half canvas so the vision judge sees equal-size halves. Composite width = `2 × halfWidth + dividerPx`, height = halfHeight.
- **`SideBySideVerdict`** — typed shape a vision judge returns: `{ energyMatchOrSurpass: boolean, structurePreserved: boolean, missingBeats?: SideBySideStructureBeat[], issues?: string[] }`.
- **`sideBySideGate(verdict) → { pass, reasons }`** — pure deterministic predicate. `pass=true` iff BOTH axes are true AND no critical `issues` line was flagged. On fail, `reasons[]` carries one string per failed axis + one per critical issue — populates the outer MAX_QA_ATTEMPTS regen loop's revise reason string. A missing-beat fail NAMES the beats (`missing beat(s): regret, risk_reversal`) so the revise turn is concrete; an invalid beat that doesn't appear in `SIDE_BY_SIDE_QC_STRUCTURE` is silently dropped (protects the enum against a wobbly judge parse).

## Callers

- [[creative-generate]] `generateCreative` — overlay branch. When `opts.designReferenceUrl` is a signed competitor skeleton URL (via [[creative-skeleton]] `signCreativeShot`), the branch fetches the bytes, calls `buildSideBySide(competitorBuffer, ourAdaptedBuffer, { ratio: aspectRatio })`, and returns the composite on the new `sideBySide?: { buffer, mimeType }` field of `GeneratedCreative`. A fetch failure is non-fatal (`console.warn` + proceed without) — the side-by-side is an audit + gate, not a blocker of the overlay path (own-brand angles legitimately have no source to grade against).
- [[creative-agent]] `stockProduct` — outer MAX_QA_ATTEMPTS regen loop. When the overlay path returned a `sideBySide` buffer, hand it to the vision judge (`qaCreativeViaBoxSession` or `qaCreative`), then call `sideBySideGate(verdict)`. `pass=false` bounces to the next attempt in the same session (mirrors the existing vision-QC bounce); `pass=true` lands the creative.

## Design choices

- **Never crop the competitor.** `fit: "contain"` letterboxes a mismatched-ratio reference to the per-half canvas with a black background. Cropping would erase the very design language we're grading against — the whole point of the side-by-side is that the judge sees the SOURCE's composition, not our cropping preference.
- **Deterministic gate, not a soft judge.** `sideBySideGate` is pure code. It converts a `SideBySideVerdict` (whatever the vision judge produced) into a boolean pass + a reasons array. The vision judge is model-based; the gate is not. This mirrors every other terminal decision on this rail (never-fabricate verifier, cold-offer-gate, `enforceOfferFidelity`).
- **Strict on either axis.** The prime directive says "match or surpass" and "preserved structure" — a mid verdict silently drifts the adaptation into a weaker version. So the gate fails on either axis, not on both.

## Tests

`src/lib/ads/creative-side-by-side.test.ts` pins the deterministic surface — the enum is stable; `buildSideBySide` produces a composite at exactly `2 × halfWidth + dividerPx` and letterboxes a landscape competitor without cropping; `outputMime="image/png"` and custom `dividerPx` honour their opts; and `sideBySideGate` passes on both-axes-true, fails on either axis with a concrete revise reason (names the missing beats), filters invalid beats, lifts free-form issue lines, and surfaces BOTH reasons when both axes fail (audit trail).

## Related

- [[../reference/competitor-ad-adaptation]] — the prime directive + the psychological-structure spine this gate enforces
- [[creative-overlay]] — layer 3 of the overlay render path (the compositor whose output is the "ours" half)
- [[creative-generate]] — the overlay branch that produces the side-by-side artifact
- [[creative-skeleton]] `signCreativeShot` — signs the competitor thumb path fed to `generateCreative` as `designReferenceUrl`
