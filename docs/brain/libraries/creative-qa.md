# `src/lib/ads/creative-qa.ts`

The **visual gate** Dahlia (the [[creative-agent|Ad Creative Agent]]) runs on every generated static before it lands in [[media-buyer-agent|Bianca]]'s ready-to-test bin. The [[creative-brief]] guarantees the *claims* are true by construction (grounded in [[product-intelligence]]); what a text-to-image model can still get wrong is the **render**. So we look at the pixels with a vision pass (Opus) rather than trusting the prompt.

## `qaCreative(workspaceId, { buffer, expectedCopy, hasTransformation }) → CreativeQAVerdict`

Downscales to Anthropic's optimal vision size (1568px, via `sharp`), then asks Opus ([[ai-models]] `OPUS_MODEL`) to check five render defects and return JSON:

| check | fails when |
|---|---|
| `headlineExact` | the headline isn't the exact expected string (dropped/repeated/misspelled/garbled words) |
| `textLegible` | any on-image text is gibberish (`IMPUSEO`, `real Ife`, `coffee coffee`) |
| `noBarePrice` | a bare sticker/MSRP price shows alone (allowed only as strikethrough→discount or per-serving) |
| `noFabricatedPhotoCaption` | text claims an image is a real/candid/verified/authentic photo ("Candid photos from her home"). Plain "Before"/"After" labels are fine |
| `transformationPhotorealistic` | a before/after image is a cartoon/illustration/3D-CGI render instead of a photorealistic photograph (true if no transformation image) |

`pass` = all five true. **Fails closed:** a missing API key, an undecodable image, or a vision-service error returns `pass:false` — nothing unchecked reaches the bin. Usage is logged via [[ai-usage]] `logAiUsage` (`purpose: "ad_creative_qa"`).

The caller ([[creative-agent]]) regenerates on a fail, up to a retry cap. The checks encode the CEO grey-area line (2026-07-10): an AI-generated before/after is allowed, but it must be photorealistic + never captioned as authentic. See [[../reference/meta-scaling-methodology]].

## Related
[[creative-agent]] · [[creative-generate]] · [[creative-brief]] · [[creative-skeleton]] (the winning-ad vision pattern this mirrors).
