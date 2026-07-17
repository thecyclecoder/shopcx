# `src/lib/ads/creative-qa.ts`

The **visual gate** Dahlia (the [[creative-agent|Ad Creative Agent]]) runs on every generated static before it lands in [[media-buyer-agent|Bianca]]'s ready-to-test bin. The [[creative-brief]] guarantees the *claims* are true by construction (grounded in [[product-intelligence]]); what a text-to-image model can still get wrong is the **render**. So we look at the pixels rather than trusting the prompt.

Two paths, one verdict shape — the caller ([[creative-agent]] `runAdCreativeLoop`, dispatched by [[builder-worker]] `runAdCreativeJob`) picks the path per the `DAHLIA_QC_MODE` env kill-switch and regenerates on `pass:false` up to `MAX_QA_ATTEMPTS`.

## Two independent gates

Two orthogonal QC modes now live in this file — one for the RENDER (Dahlia's own visual QC of the image she generated), and one for the CAPTION (Max's INDEPENDENT copy-QC of the text Dahlia wrote). Each has its own env kill-switch and its own agent-kind so the founder can turn either on or off without touching the other.

| what | env | agent-kind | skill | writes | spec |
|---|---|---|---|---|---|
| Render QC (visual defects) | `DAHLIA_QC_MODE=box\|direct` (default `box`) | `ad-creative-qc` | [[creative-qc]] | inline verdict; regenerates on fail | [[../specs/dahlia-creative-qc-via-box-session]] |
| Copy QC (Max independent) | `DAHLIA_QC_COPY_MODE=box\|off` (default `off`) | `ad-creative-copy-qc` | [[../../../.claude/skills/max-copy-qc/SKILL]] | `ad_creative_copy_qc_verdicts` + bounces to a copy-only revise | [[../specs/dahlia-max-independent-copy-qc-box-session]] |

The copy-QC path (Phase 2 wire) reuses the same `sandbox: "qc"` env-stripping contract as the render QC — a grep-able `copy-qc` alias in [[builder-worker]] `runBoxSession` routes to the SAME `buildQcChildEnv` filter, so no second env-filter implementation drifts. The PreToolUse gate ([[ad-creative-qc-permission-gate]]) is reused verbatim.

## `DAHLIA_QC_MODE` kill-switch (dahlia-creative-qc-via-box-session Phase 2) — RENDER QC

| value | path | when to flip |
|---|---|---|
| `box` (default; unset also = `box`) | `qaCreativeViaBoxSession` — a top-level `claude -p` on Max via the creative-qc skill | production; no `ANTHROPIC_API_KEY` needed |
| `direct` | `qaCreative` — direct Opus vision API call (unchanged) | one-flag revert if the box-session path misbehaves |

Any other value degrades to `box` (safest default — a typo doesn't silently regress a working rollout). Set on the box worker's env; no redeploy needed. The direct path still requires `ANTHROPIC_API_KEY` in the lane env; the box path does not (the spawned `claude` child strips it via `sandbox: "max"`).

## `qaCreativeViaBoxSession(gen, dispatch) → CreativeQAVerdict` — the default box-session path

The worker builds a `dispatch(prompt) → { resultText, isError }` closure that runs one `claude -p` session on Max (kind `ad-creative-qc`, sandbox `qc`, 6-min hard cap / 90s idle) through `runBoxLane` (per-account failover; all accounts capped → fail-closed). The function:

1. Normalizes the buffer to Anthropic's optimal vision size (1568px JPEG, same `sharp` pass as `qaCreative`).
2. Writes it to `/tmp/creative-qc-<uuid>.jpg` and hands the ABSOLUTE PATH + the exact copy strings (`HEADLINE`, `OFFER`, `TRUST BAR`, `HAS_TRANSFORMATION`) to the `.claude/skills/creative-qc` skill via [[creative-qc-sandbox]] `buildQcPrompt` (which sanitizes + delimits the untrusted copy fields — Phase 3 / Fix 1 injection defence).
3. The skill `Read`s the image (Claude Code renders JPEGs visually to the model), judges the five render defects below, and returns the `CreativeQAVerdict` JSON.
4. The tmpfile is deleted in a `finally` block — best-effort; a leaked jpeg is harmless but noise.

**Fail-closed on every error path:** undecodable image, tmpfile write error, dispatch throw, `isError:true` from the session (spawn/cap/timeout), unparseable JSON, or a mismatched top-level `pass` (checks all true but `pass:false`, or vice versa) → `pass:false` with a reason in `issues`. Nothing unchecked reaches the bin.

## `qaCreative(workspaceId, { buffer, expectedCopy, hasTransformation }) → CreativeQAVerdict` — the direct legacy path

The pre-Phase-1 path: same 1568px JPEG normalization, but the vision pass is a direct `POST https://api.anthropic.com/v1/messages` call with `OPUS_MODEL` ([[ai-models]]) and the base64 image inline. Usage is logged via [[ai-usage]] `logAiUsage` (`purpose: "ad_creative_qa"`). Fails closed the same way — missing `ANTHROPIC_API_KEY`, an undecodable image, or a vision-service error returns `pass:false`. Retained as the `DAHLIA_QC_MODE=direct` fallback so a bad rollout is one env flag away from revert.

## The seven render checks (identical on both paths)

| check | fails when |
|---|---|
| `headlineExact` | the headline isn't the exact expected string (dropped/repeated/misspelled/garbled words). **Imitation exception (2026-07-13):** a competitor-imitation's headline is rewritten off the competitor's brand, so `expectedCopy.headline` is BLANK — both paths signal `imitationHeadline` (a TRUSTED flag, outside the injection-guarded DATA block: direct via the expected-copy preamble, box via [[creative-qc-sandbox]] `buildQcPrompt`) and the QC returns `headlineExact=true` (nothing to exact-match); a garbled headline still fails `textLegible` |
| `textLegible` | **READABLE** on-image text is gibberish (`IMPUSEO`, `real Ife`, `coffee coffee`) — headline, subhead, offer, review quote, trust bar, the product's MAIN wordmark, or a prominent badge. **Calibrated 2026-07-13:** sub-readable pouch micro-text (the tiny ingredient-icon ring / fine-print band Nano Banana garbles on nearly every render) is NOT a defect — it's invisible at feed scale, like real product-photo fine print. The line is READABILITY, not "any text on the pack." In imitation mode, **any competitor brand name appearing anywhere** still fails |
| `noBarePrice` | a bare sticker/MSRP price shows alone (allowed only as strikethrough→discount or per-serving) |
| `noFabricatedPhotoCaption` | text claims an image is a real/candid/verified/authentic photo ("Candid photos from her home"). Plain "Before"/"After" labels are fine |
| `transformationPhotorealistic` | a before/after image is a cartoon/illustration/3D-CGI render instead of a photorealistic photograph (true if no transformation image) |
| `packagingFaithful` | the product package rendered in the ad does not match the real reference packshot on wordmark, dominant pack colors, flavor art / hero graphic, or overall pack shape (an invented pack, wrong-color pack, fabricated wordmark, competitor pack still visible). Sub-readable ingredient icons + supplement-facts fine print stay out of scope (same as `textLegible`). Fails closed on ambiguity. When no reference packshot is supplied (own-brand path — [[creative-agent]]'s Phase-1 gate already refused to composition-transfer without one), the check is **skipped** locally so a legitimate render is never false-failed |
| `offerConsistent` | a discount/percent-off/dollar-off/free-shipping/BOGO/"X for $Y" claim shown on the image does not match `realOffer` (our REAL store offer), OR two conflicting discount numbers appear on the same ad. When no `realOffer` is threaded the check is **skipped** locally (stays true) so a legitimate no-offer render is never false-failed. Fails closed on ambiguity |

`pass` = all seven true. The checks encode the CEO grey-area line (2026-07-10): an AI-generated before/after is allowed, but it must be photorealistic + never captioned as authentic. See [[../reference/meta-scaling-methodology]].

## Packaging fidelity (ad-creative-requires-real-packshot-never-invent-packaging Phase 2)

The QA vision compare now takes an optional `packshotUrl` — the isolated packshot from [[../tables/product_variants]]`.isolated_image_url` (surfaced via [[creative-brief]] `pi.media.isolatedPackshots[0]` → `brief.imageRefs[role='packshot']`, threaded by [[creative-agent]] `stockProduct`). When present, the QC session Reads BOTH the rendered creative AND the reference packshot and judges `packagingFaithful` by comparing wordmark / dominant colors / flavor art / pack shape. This closes the 2026-07-14 Ashwavana Zen Relax loophole where a fabricated pack (a pink pouch in one draft, a red box in another) passed QA into the bin because no check compared the render against our real packshot.

Two mechanisms make the box-session path safe for two images:
- **`AD_CREATIVE_QC_ALLOWED_IMAGE` is now a comma-separated set.** [[creative-qc-sandbox]] `parseAllowedImagePaths` splits + trims, and `evaluateQcPermission` asserts Set membership — Read on either allowed path allows, Read on any other path (a stray QC job's leftover, /etc/passwd) still denies. A single-path env value (no commas) stays a set-of-one, so every pre-Phase-2 call site keeps its exact behavior.
- **`buildQcPrompt` gained a TRUSTED packshot rule** outside the untrusted DATA block. With a reference: `PACKAGING-FIDELITY MODE — REFERENCE-VERIFY` + a `REFERENCE_PACKSHOT: <path>` line and the `packagingFaithful` field in the verdict schema. Without: `PACKAGING-FIDELITY MODE — NO REFERENCE` + instructions to return `packagingFaithful=true` (skip).

**Defense-in-depth for the skip path:** both `qaCreative` and `qaCreativeViaBoxSession` ALSO force `checks.packagingFaithful=true` locally when no packshot was loaded (or the fetch/tmpfile-write failed) — a model that spuriously returns false for the field in skip mode can't false-fail a legitimate own-brand render, because the local override neutralizes it. A packshot fetch failure logs `qa_packshot_fetch_failed` and downgrades to skip (rather than fail-closing the whole verdict) because Phase 1 already refused to composition-transfer against a missing packshot — a transient CDN hiccup shouldn't starve the bin on top of that.

## Offer consistency (ad-creative-only-our-real-offer-discount-shown-never-a-competitors Phase 2)

The QA vision compare also takes an optional `realOffer` — our REAL store offer (from [[creative-brief]] `brief.offer`, threaded by [[creative-agent]] `stockProduct`). `summarizeOfferForQa` collapses it into a single line (`HEADLINE: "…" · STRIKETHROUGH: "…" · PER_SERVING: "…"`) that the vision QC compares every rendered discount claim against. When any percent-off/dollar-off/free-shipping/BOGO/"X for $Y" claim on the image does not match — or two conflicting discount numbers appear on the same ad — `offerConsistent` fails, the verdict fails, and Dahlia regenerates (or drops the creative after `MAX_QA_ATTEMPTS`). Closes the 2026-07-14 Amazing Creamer regression where the headline screamed **"50% OFF"** (leaked from a reused competitor hook — the failure Phase 1 killed upstream) while our real offer badge said **"Up to 34% off"** and the pre-Phase-2 QA (whose price check only forbade a bare MSRP) passed the mismatched pair straight into the bin.

Same trust-boundary + skip-semantic wiring as `packagingFaithful`:
- **`buildQcPrompt` gained a TRUSTED offer rule** outside the untrusted DATA block ([[creative-qc-sandbox]] `realOfferSummary` input). With a real offer: `OFFER-CONSISTENCY MODE — REAL-OFFER` + the summary string + the fail-on-mismatch rule + `offerConsistent` in the verdict schema. Without: `OFFER-CONSISTENCY MODE — NO REFERENCE` + instructions to return `offerConsistent=true` (skip). The rule lives ABOVE `===BEGIN_QC_DATA_v1===` so an untrusted copy string can never forge a bogus real-offer summary that flips the verdict.
- **Defense-in-depth skip:** both paths force `checks.offerConsistent=true` locally when no real offer reached the model — a spuriously-false CHECK from a stray model answer can't false-fail a legitimate no-offer render.
- **Skip semantic:** the local override is guarded by the CHECK field, not the top-level `pass` — a well-behaved model in skip mode should still return `pass:true`; the fixture in [[../../../src/lib/ads/creative-qa.test.ts]] "no realOffer supplied → skip forces checks.offerConsistent=true" pins that.

## Related
[[creative-agent]] · [[creative-generate]] · [[creative-brief]] · [[creative-skeleton]] (the winning-ad vision pattern this mirrors) · [[../lifecycles/ad-creative]] · [[creative-qc]] (the box-session skill) · [[creative-qc-sandbox]] (the guardrails + prompt-building layer) · [[ad-creative-qc-permission-gate]] (the PreToolUse hook).
