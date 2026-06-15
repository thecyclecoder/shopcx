# `src/lib/ad-statics-copy.ts` — copy generation for killer statics

Per-archetype Opus copy for the static archetypes whose text is generated (advertorial / big_claim / before_after). The testimonial + authority archetypes use REAL review / endorsement text verbatim, so they do **not** pass through here. Mirrors [[ad-meta-copy]] / [[ad-script]] (Anthropic Messages API, `OPUS_MODEL`). See [[../specs/killer-statics]].

## Exports

| Export | Returns |
|---|---|
| `generateAdvertorialCopy(workspaceId, inputs, angle, heroKind)` | `AdvertorialCopy` (category, headline, dek, body[], heroCaption) |
| `generateBigClaimCopy(workspaceId, inputs, angle)` | `BigClaimCopy` (eyebrow, hook, emphasis, reveal) — `emphasis` forced to a real substring of `hook` |
| `generateBeforeAfterCopy(workspaceId, inputs, angle)` | `BeforeAfterCopy` (headline, beforeText, afterText) |
| `AdvertorialHeroKind` | `avatar` \| `ingredient` |

`inputs` is [[ad-angles]] `AngleGeneratorInput`; `angle` is an optional `product_ad_angles` row.

## Rules (hard — Dylan, 2026-06-15)
- **Anchor to CORE desires:** weight loss · fighting aging · best self · being noticed/liked. NEVER lead with functional/secondary benefits (energy, "no jitters", "no 2pm crash", focus).
- Banned-word gate via [[ad-validator]] `validateAdScript` (only the `banned_word` code is treated as fatal — the opener/length/soft-CTA codes are video-specific and would false-positive on static copy).
- **Graceful degradation:** no API key or unparseable output → proven default copy (the pipeline never hard-fails). `logAiUsage` per call.

## Callers
- `src/lib/ad-statics.ts` — `buildKillerStatic`.

## Related
[[ad-statics]] · [[ad-meta-copy]] · [[ad-script]] · [[ad-angles]] · [[ad-validator]] · [[../specs/killer-statics]]
