# `src/lib/ads/creative-qa.ts`

The **visual gate** Dahlia (the [[creative-agent|Ad Creative Agent]]) runs on every generated static before it lands in [[media-buyer-agent|Bianca]]'s ready-to-test bin. The [[creative-brief]] guarantees the *claims* are true by construction (grounded in [[product-intelligence]]); what a text-to-image model can still get wrong is the **render**. So we look at the pixels rather than trusting the prompt.

Two paths, one verdict shape — the caller ([[creative-agent]] `runAdCreativeLoop`, dispatched by [[builder-worker]] `runAdCreativeJob`) picks the path per the `DAHLIA_QC_MODE` env kill-switch and regenerates on `pass:false` up to `MAX_QA_ATTEMPTS`.

## `DAHLIA_QC_MODE` kill-switch (dahlia-creative-qc-via-box-session Phase 2)

| value | path | when to flip |
|---|---|---|
| `box` (default; unset also = `box`) | `qaCreativeViaBoxSession` — a top-level `claude -p` on Max via the creative-qc skill | production; no `ANTHROPIC_API_KEY` needed |
| `direct` | `qaCreative` — direct Opus vision API call (unchanged) | one-flag revert if the box-session path misbehaves |

Any other value degrades to `box` (safest default — a typo doesn't silently regress a working rollout). Set on the box worker's env; no redeploy needed. The direct path still requires `ANTHROPIC_API_KEY` in the lane env; the box path does not (the spawned `claude` child strips it via `sandbox: "max"`).

## `qaCreativeViaBoxSession(gen, dispatch) → CreativeQAVerdict` — the default box-session path

The worker builds a `dispatch(prompt) → { resultText, isError }` closure that runs one `claude -p` session on Max (kind `ad-creative-qc`, sandbox `max`, 6-min hard cap / 90s idle) through `runBoxLane` (per-account failover; all accounts capped → fail-closed). The function:

1. Normalizes the buffer to Anthropic's optimal vision size (1568px JPEG, same `sharp` pass as `qaCreative`).
2. Writes it to `/tmp/creative-qc-<uuid>.jpg` and hands the ABSOLUTE PATH + the exact copy strings (`HEADLINE`, `OFFER`, `TRUST BAR`, `HAS_TRANSFORMATION`) to the `.claude/skills/creative-qc` skill in the prompt.
3. The skill `Read`s the image (Claude Code renders JPEGs visually to the model), judges the five render defects below, and returns the `CreativeQAVerdict` JSON.
4. The tmpfile is deleted in a `finally` block — best-effort; a leaked jpeg is harmless but noise.

**Fail-closed on every error path:** undecodable image, tmpfile write error, dispatch throw, `isError:true` from the session (spawn/cap/timeout), unparseable JSON, or a mismatched top-level `pass` (checks all true but `pass:false`, or vice versa) → `pass:false` with a reason in `issues`. Nothing unchecked reaches the bin.

## `qaCreative(workspaceId, { buffer, expectedCopy, hasTransformation }) → CreativeQAVerdict` — the direct legacy path

The pre-Phase-1 path: same 1568px JPEG normalization, but the vision pass is a direct `POST https://api.anthropic.com/v1/messages` call with `OPUS_MODEL` ([[ai-models]]) and the base64 image inline. Usage is logged via [[ai-usage]] `logAiUsage` (`purpose: "ad_creative_qa"`). Fails closed the same way — missing `ANTHROPIC_API_KEY`, an undecodable image, or a vision-service error returns `pass:false`. Retained as the `DAHLIA_QC_MODE=direct` fallback so a bad rollout is one env flag away from revert.

## The five render checks (identical on both paths)

| check | fails when |
|---|---|
| `headlineExact` | the headline isn't the exact expected string (dropped/repeated/misspelled/garbled words) |
| `textLegible` | any on-image text is gibberish (`IMPUSEO`, `real Ife`, `coffee coffee`) |
| `noBarePrice` | a bare sticker/MSRP price shows alone (allowed only as strikethrough→discount or per-serving) |
| `noFabricatedPhotoCaption` | text claims an image is a real/candid/verified/authentic photo ("Candid photos from her home"). Plain "Before"/"After" labels are fine |
| `transformationPhotorealistic` | a before/after image is a cartoon/illustration/3D-CGI render instead of a photorealistic photograph (true if no transformation image) |

`pass` = all five true. The checks encode the CEO grey-area line (2026-07-10): an AI-generated before/after is allowed, but it must be photorealistic + never captioned as authentic. See [[../reference/meta-scaling-methodology]].

## Related
[[creative-agent]] · [[creative-generate]] · [[creative-brief]] · [[creative-skeleton]] (the winning-ad vision pattern this mirrors) · [[../lifecycles/ad-creative]] · [[creative-qc]] (the box-session skill).
