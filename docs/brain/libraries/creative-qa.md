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

## Shared deterministic copy validator (dahlia-shared-deterministic-copy-validator Phase 2 — WIRED)

`runQaCreativeCopyViaBoxSession` — the Node lane dispatcher for Max's per-creative INDEPENDENT copy-QC box session ([[../specs/dahlia-max-independent-copy-qc-box-session|M1 keystone]]) — **pre-computes** [[copy-validator]] `validateGeneratedCopy` on Dahlia's finished copy BEFORE dispatching Max, and threads the typed `{pass, checks[]}` into the session prompt as a `===BEGIN_VALIDATOR_TRUSTED_CONTEXT_v1===` / `===END_VALIDATOR_TRUSTED_CONTEXT_v1===` **TRUSTED CONTEXT block** — outside the untrusted `===BEGIN_COPY_QC_DATA_v1===` DATA fence, matching the sanitize/delimit trust boundary [[creative-qc-sandbox]] documents for the image-QC dispatcher. Max reads which rails already passed / failed and MUST cite the SAME rail names in his `hard_gates` output when he decides to bounce for a safety reason, so a validator miss and a Max hard-gate fail always talk about the same six categories (`lf8` / `meta_caps` / `no_msrp` / `no_competitor_leak` / `cold_offer_gate` / `single_promise`).

Max still forms his own persuasion judgment against the 5-lens rubric ([[../../../.claude/skills/max-copy-qc/SKILL.md|max-copy-qc]] SKILL) — the shared validator only feeds him the SAFETY-rail truth (persuasion stays in the rubric, safety stays deterministic). The pre-check is factored out as a pure helper `computeCopyQcPreCheck(input) → {validator, trustedContextBlock}` so a future dispatcher can inline the same formatter without spawning a session, and the outcome carries the validator result on BOTH success and dispatch-error paths so operators can observe a mismatched pair (Max says clean while the validator says a rail failed) downstream. Pinned by [[../../../src/lib/ads/creative-qa.copy-qc.test.ts]] (`npx tsx --test src/lib/ads/creative-qa.copy-qc.test.ts`).

The same [[copy-validator]] `validateGeneratedCopy` is the SSOT [[creative-agent]] `runCopyAuthorSession`'s post-author self-check reads — kept in ONE place so the author's self-check and Max's pre-check cannot drift.

## Max verdict — type + parser + SDK persistence (max-copy-qc-scroll-stop-dims Phase 1)

Three co-located pieces materialize Max's per-session verdict onto [[../tables/ad_creative_copy_qc_verdicts]]:

- **`CopyQaVerdict`** — the strict-JSON verdict shape Max's [[../../../.claude/skills/max-copy-qc/SKILL]] documents. Carries `hard_gate_pass`, the five `hard_gates` booleans, `persuasion_score` + `persuasion_rubric` (nullable on a fail), a REQUIRED `scroll_stop` (sub-scores are `0 | 1 | 2 | null` — the parser fills a neutral null default when Max omits the advisory field, see below), and `verdict_reason`.
- **`parseCopyQaVerdict(raw)`** — strict-JSON parser that fail-closes on: undecodable JSON, missing / non-object `hard_gates`, non-boolean per-check, a mismatched pair (`hard_gate_pass=true` with a per-check `false`), `persuasion_score` outside `0..10` on a pass, and a PRESENT-but-malformed `scroll_stop` (non-object, non-integer sub-score, sub-score outside `0..2`, non-string-array evidence). A MISSING or NULL `scroll_stop` is **tolerated** — the parser fills a neutral advisory default (all sub-scores null + empty evidence) so an omitted advisory field doesn't nuke Max's real hard_gates + persuasion_score grade ([[../specs/max-qc-always-bins-ad-7of10-gates-only-bianca-postability]] Phase 1). An advisory sub-score should never nuke a real grade; present-but-malformed still fail-closes because that's a genuine defect. Returns `{ kind: "ok", verdict }` or `{ kind: "parse_error", reason }`; the caller treats a parse_error the same as a hard-gate fail (bounce Dahlia's session; never let unchecked bytes land on the row).
- **`insertCopyQaVerdict(admin, opts)`** — the SDK-chokepoint helper for [[../tables/ad_creative_copy_qc_verdicts]]. Always writes `scroll_stop` on the row (either Max's real sub-scores or the parser's neutral-null default when he omitted the advisory field); the Node lane never reaches raw `admin.from("ad_creative_copy_qc_verdicts").insert(...)`. Returns `{ id }` on success and `null` on an insert error — a durable-audit row is important but the pipeline continues on write failure.

> **⭐ Max KNOWS the proofStack brand facts are grounded (proofstack-is-a-citeable-claim-source, 2026-07-18):** the [[../../../.claude/skills/max-copy-qc/SKILL|max-copy-qc]] SKILL's `no_fabrication` hard gate is now explicit that the CEO-verified brand facts on `brief.proofStack` — **700,000+ customers** (social proof) · **30-day money-back guarantee** (risk reversal / Cialdini commitment) · **15,000+ reviews** · **"Best Tasting" — Gourmet Magazine** (authority) · **Non-GMO** · **3rd-party tested** · **Made In USA** — are grounded. A caption citing any of these passes `no_fabrication:true` AND the `cialdini` rubric axis notes that reward-worthy usage scores `2`. Root cause the spec closed: Max's SKILL previously had no signal these were grounded, so he neither reliably credited their use nor was reminded they're real (a failure mode that let weaker copy pass while a Cialdini-anchored variation using the strongest brand levers went unrewarded). A fabricated inflation (`"8,000,000+ customers"`) is still fabrication — the number must trace to `brief.proofStack`, which is what the layer-3 [[never-fabricate]] `verifyClaimTrace` `proofStack` branch checks.

### Three scroll-stop dimensions ([[../specs/max-copy-qc-scroll-stop-dims]] Phase 1)

The M1 keystone's rolled-up `persuasion_score` (0-10) rolls FIVE lenses into one number — great for a rolled-up read, useless for correlating a specific scroll-stop failure mode against realized CAC. `scroll_stop` names three ADVISORY dimensions, each 0 / 1 / 2, so future CAC-correlation work has a granular signal:

| dimension | what it measures |
|---|---|
| `headline_readable_in_3_frames` | the top-line copy is legible within ≤3 feed-scroll frames of Meta thumb-cadence viewing (a real buyer flicks Reels/Feed at ~1 second per card) |
| `visual_hierarchy_supports_headline` | there is a single dominant visual anchor that doesn't fight the headline for attention (one hero object, one focal face, one focal transformation) |
| `first_line_earns_the_second` | the primary-text opener creates enough curiosity / stakes / specificity to keep the reader past the `…See more` fold (≈125 chars in Meta feed) |

**No-Goodhart contract.** The sub-scores NEVER block `hard_gate_pass` — a caption can score 0/0/0 on scroll_stop and still land in Bianca's bin if every hard gate is green. The moment a low sub-score gates the pipeline, it stops being an honest signal and becomes something to game — the M1 keystone's line-27 "advisory director" clause explicitly bans this. If a low `first_line_earns_the_second` starts predicting high CAC, the fix is a Dahlia author-mode revise directive; not a new hard gate reading off this column.

Pinned by [[../../../src/lib/ads/creative-qa.copy-qc.test.ts]] tests `(e)` / `(f)` — verdict WITH scroll_stop → row body carries the field; verdict missing / null → `ok` with a neutral-null default (advisory absence tolerated so the real grade survives — [[../specs/max-qc-always-bins-ad-7of10-gates-only-bianca-postability]] Phase 1); verdict with an out-of-range sub-score → `parse_error` fail-closed (present-but-malformed is still a defect).

### Intent-aware 5-axis rubric ([[../specs/dahlia-researches-from-winners-flow-ad-library]] Phase 2)

Phase 2 wires **Max's INTENT-AWARE 5-axis rubric** into the same QC session so Dahlia's Phase 1 declared intent (`{audience_temperature, purpose}` from [[creative-sourcing|CreativeIntent]] / `resolveResearchIntent`) drives the grade, not blind vibes.

- **`DahliaCreativeRubric`** — the 5 axes Max scores on every Dahlia creative (1..10 + reason): `competitor_selection · temperature_selection · creative_quality · scroll_stopping · dr_consumer_psychology`. Grounded in the spec's supervisable-autonomy rule: Dahlia optimizes a proxy (bin depth); Max grades her on the dimensions that actually make a static win, and does so INTENT-AWARE.
- **`parseDahliaRubric(raw)`** + **`parseDeclaredIntent(raw)`** — pure parsers wired into `parseCopyQaVerdict`. Fail-closed on malformed (partial axis / out-of-range score 1..10 / empty reason / bad temperature literal); TOLERANT of absence so a legacy M1 verdict emitted before Phase 2 parses byte-identical to today.
- **`renderMaxDahliaRubricTrustedContext(input)`** — the pure TRUSTED CONTEXT block `runQaCreativeCopyViaBoxSession` inlines above the DATA fence when the caller threads `declaredIntent`. Sanitized worker-computed context (same fence pattern as `computeCopyQcPreCheck`'s validator block). Names each of the 5 axes, echoes the declared temperature, and — for a competitor imitation — includes the underlying winner's [[creative-skeleton|ConceptTags]] benchmark (`angle · archetype · awareness_stage · cialdini_lever · why_it_works`). When `declaredIntent` is null the function returns `""` so the M1 keystone prompt stays byte-identical.
- **`insertCopyQaVerdict`** — the SDK helper now also writes `declared_intent` + `dahlia_rubric` on the [[../tables/ad_creative_copy_qc_verdicts]] row alongside `scroll_stop`.
- **`readLatestCopyQaVerdict`** — the read chokepoint selects the two new columns too, so downstream (ad detail page, future Phase 3 gate) reads one consistent `StoredCopyQaVerdict` shape.

The migration adding the two `jsonb` columns is `supabase/migrations/20261102120000_ad_creative_copy_qc_verdicts_dahlia_rubric.sql` (additive `add column if not exists`, auto-applied by the Control Tower migration-drift reconciler once the PR merges to main — no bespoke pre-merge apply required). Paired apply script `scripts/apply-ad-creative-copy-qc-verdicts-dahlia-rubric-migration.ts` exists so the `tagPendingActionType` classifier can re-tag any manual invocation and self-approve.

**Advisory in Phase 2 — no hard-gate driver.** Phase 3 wires the ready-to-bin threshold that reads this column to enforce a min composite / trigger a revise loop; the gate ships in a separate module [[dahlia-rubric-gate]] so it's independently testable. Any code path reading `dahlia_rubric` outside `dahlia-rubric-gate` MUST NOT gate campaign readiness on it — the gate is the sanctioned reader.

Pinned by [[../../../src/lib/ads/creative-qa.dahlia-rubric.test.ts]] (12 cases).

## Related
[[creative-agent]] · [[creative-generate]] · [[creative-brief]] · [[creative-skeleton]] (the winning-ad vision pattern this mirrors) · [[../lifecycles/ad-creative]] · [[creative-qc]] (the box-session skill) · [[creative-qc-sandbox]] (the guardrails + prompt-building layer) · [[ad-creative-qc-permission-gate]] (the PreToolUse hook) · [[copy-validator]] (SSOT safety rails).
