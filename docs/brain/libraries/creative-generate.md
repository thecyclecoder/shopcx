# `src/lib/ads/creative-generate.ts`

Turns a fully-backed [[creative-brief]] into an actual static ad via [[gemini]] `generateNanoBananaProCombine` (Nano Banana Pro). The [[creative-brief]] is the brain; this is the hand. Deterministic prompt assembly from the brief's structured fields — the acquisition hook leads, retention truths ride in the body, proof is real, and price appears ONLY via an allowed treatment. See [[../reference/meta-scaling-methodology]].

## `generateCreative(workspaceId, brief, opts) → GeneratedCreative`

Returns `{ buffer, mimeType, prompt, expectedCopy }`. `expectedCopy` is the exact `{ headline, offer, trust }` the QA pass must verify renders un-garbled.

`buildPrompt(brief, hasDesignRef)` assembles the Nano Banana prompt:
- **Headline** = `brief.angle.hook`, rendered EXACTLY (the anti-garble instruction), one key phrase in a color block.
- **Transformation** = the brief's single real reviewer, quote + name rendered EXACTLY (a genuine review). See the image rule below.
- **Supporting** = 1–2 retention truths as a small secondary line.
- **Trust bar** = first 4 of `brief.proofStack`.
- **Offer** = shown ONCE as a single badge (`offer.headline`), optionally the per-serving value or the strikethrough+disclaimer. **Never a bare MSRP** (hard rule).

`opts.designReferenceUrl` passes a proven winner as the FIRST image to match its design language.

### Image guardrails (the grey-area line)
- The **quote + reviewer name must be a REAL review** — never invent a name, alter a quote, or add a fake "verified purchase" badge.
- A **before/after transformation image MAY be AI-generated** when the real reviewer submitted no photo (CEO-accepted risk, 2026-07-10) — but it **must be PHOTOREALISTIC**: an actual-photograph look (real skin texture, natural lighting, candid-from-home framing), **never a cartoon / illustration / drawing / 3D-CGI render**. The 2026-07-10 first pass rendered a cartoon couple; the prompt now hard-forbids illustration style in both the transformation clause and the HARD RULES line.
- The story must be **self-consistent**: one reviewer, one number, headline = caption = photo person (avoids the "84 lbs headline / 63 lbs caption / third person's photo" bug).
- Only `http(s):` / `data:` image URLs are passed to Gemini; relative storage paths are filtered out (they can't be fetched).

## The QA pass (caller's job)
The Ad Creative Agent (a Max-session lane) calls `generateCreative`, then **visually QAs** the returned bytes against `expectedCopy` — garbled/dropped text, any fabrication, a bare price, a duplicated offer badge, or a cartoon transformation — and **regenerates on fail** before landing it in [[media-buyer-agent|Bianca]]'s ready-to-test bin.

## Next
Slice 3: the cadence lane (box job kind + cron watching bin depth) + bin insertion (`ad_campaigns` ready) + the agent's persona (peer to Bianca under Max). [[creative-brief]] · [[product-intelligence]] · [[gemini]] · [[../functions/growth]].
