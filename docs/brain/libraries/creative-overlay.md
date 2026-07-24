# `src/lib/ads/creative-overlay.ts`

The deterministic font-engine copy compositor for Dahlia's 3-layer render path (dahlia-competitor-ad-adaptation-overlay-render Phase 1). Image models garble text ("relaxant" → "relaxan"), and no prompt makes a diffusion model reliably text-accurate. The fix: render a **TEXT-FREE** scene via Nano Banana Pro (layer 1), then composite the actual copy with a real font engine (SVG → sharp) so spelling is guaranteed exact on every ratio. This module owns **layer 3** (copy overlay); layer 1 is prompted by `buildTextFreeScenePrompt` in [[creative-generate]] behind the `DAHLIA_RENDER_MODE=overlay` flag. See [[../reference/competitor-ad-adaptation]] Part 2 (3-layer overlay) + Part 3 (compositor).

## Exports

- **`OverlayCopy`** — the five text slots of the overlay: `headline` (required, heavy/bold, top), `regret?` (light sub-headline), `benefitStack?` (bold italic — the one high-contrast block), `payoff?` (light), `cta?` (badge). Matches the worked SpoiledChild "SORRY IN ADVANCE" → Amazing Creamer methodology; only `headline` is required so the same compositor works for a simpler own-brand overlay.
- **`OverlayOpts`** — `outputMime` (jpeg default, png), and optional `width`/`height` to override the ratio's default canvas.
- **`buildOverlaySVG(copy, ratio, opts?) → string`** — pure, deterministic. Emits the SVG text layer with the ratio-appropriate canvas (`viewBox` 0 0 W H), scrims behind the top + bottom text zones for legibility ("Legibility is ours to guarantee" — Part 3 rule), and the five slots. All copy is XML-escaped via `escapeXml`.
- **`compositeCopyOverlay(baseImage, copy, ratio, opts?) → { buffer, mimeType }`** — async. Resizes the base to the ratio's nominal canvas (1080-family, matches Meta ad specs), composites the SVG on top via `sharp`, and returns jpeg (or png if `outputMime="image/png"`).
- **`escapeXml(s) → string`** — pure. Escapes `& < > " '` so untrusted (AI-authored) copy is safe inside SVG.

Nominal canvas sizes: `4:5 → 1080×1350`, `9:16 → 1080×1920`, `1:1 → 1080×1080`, and the rest of Nano Banana's supported aspect set (see `NanoBananaAspect` in [[gemini]]).

## Phase-1 scope

Correct + functional: the compositor lands each copy slot on the canvas with sensible defaults, scrims for legibility, and XML-safe text. **What's deliberately deferred to Phase 3 of the spec:** per-ratio safe zones (Meta unified 2026: 9:16 keeps text+CTA within 14% top / 20% bottom / 6% sides), area-first font-fit (define the box, size the font to fill it), scene-aware clear-zone routing (full-width open top ⇒ full-width blocks; side column ⇒ left column), and the source-matched type treatment (light body / bold-italic benefit stack / matched vertical rhythm / no orphans). Wire the compositor first; typography-perfect it after the side-by-side proves the base render survives real copy.

## Callers

- [[creative-generate]] `generateCreative` — when `isOverlayRenderModeEnabled()` (i.e. `process.env.DAHLIA_RENDER_MODE === "overlay"`), the flag-gated branch calls `compositeCopyOverlay` on the text-free scene bytes from Nano Banana Pro. Kept opt-in exactly like `DAHLIA_COPY_MODE`: proved-before-default against Bianca's realized cold-audience CAC/CTR, never a rip-and-replace of the legacy model-draws-text path.

## Tests

`src/lib/ads/creative-overlay.test.ts` pins the deterministic surface — SVG contains the copy strings verbatim (XML-escaped), each ratio maps to the right `viewBox`, `compositeCopyOverlay` returns a valid image whose bytes differ from a plain resize of the untouched base (proof the overlay actually landed), and `outputMime="image/png"` honours the encoding switch.
