# `src/lib/ads/creative-overlay.ts`

The deterministic font-engine copy compositor for Dahlia's 3-layer render path (dahlia-competitor-ad-adaptation-overlay-render Phase 1). Image models garble text ("relaxant" → "relaxan"), and no prompt makes a diffusion model reliably text-accurate. The fix: render a **TEXT-FREE** scene via Nano Banana Pro (layer 1), then composite the actual copy with a real font engine (SVG → sharp) so spelling is guaranteed exact on every ratio. This module owns **layer 3** (copy overlay); layer 1 is prompted by `buildTextFreeScenePrompt` in [[creative-generate]] behind the `DAHLIA_RENDER_MODE=overlay` flag. See [[../reference/competitor-ad-adaptation]] Part 2 (3-layer overlay) + Part 3 (compositor).

## Exports

- **`OverlayCopy`** — the five text slots of the overlay: `headline` (required, heavy/bold, top), `regret?` (light sub-headline), `benefitStack?` (bold italic — the one high-contrast block), `payoff?` (light), `cta?` (badge). Matches the worked SpoiledChild "SORRY IN ADVANCE" → Amazing Creamer methodology; only `headline` is required so the same compositor works for a simpler own-brand overlay.
- **`OverlayOpts`** — `outputMime` (jpeg default, png), optional `width`/`height` to override the ratio's default canvas, and `clearZone` (scene-aware Phase-3 hint — see below).
- **`OverlayClearZone`** — `"top_band" | "side_column_left" | "side_column_right"`. Phase-3 scene-aware hint. `top_band` (default) = full-width text block above the product; `side_column_*` = column layout with the product on the opposite side. Part 3 rule: "The text-box shape follows the scene's actual clear zone."
- **`SAFE_ZONES: Record<NanoBananaAspect, SafeZone>`** — Meta unified 2026 numbers (Phase 3, grep-token for the safe-zones-enforced verification): `9:16 = { topPct: 0.14, bottomPct: 0.20, sidesPct: 0.06 }` (Stories/Reels chrome eats top + bottom hardest), `4:5 = { 0.14, 0.14, 0.06 }` (Feed 14% breathing room all sides), `1:1 = { 0.10, 0.10, 0.06 }` (right-column, lighter chrome). Every text/CTA element is placed inside `[topPct, 1-bottomPct] × [sidesPct, 1-sidesPct]` of the canvas.
- **`fitFontToBox({ text, maxWidthPx, maxHeightPx, minPx, maxPx, weight, italic?, lineHeightRatio? }) → { fontSizePx, lines, lineHeightPx, fitsAtMax }`** — Phase-3 area-first font-fit (grep-token for the fit-to-box-typography verification). Deterministic + pure. Picks the largest font size in `[minPx, maxPx]` that lets the wrapped text fit the box; applies `wrapTextToBox` + `fixOrphans` per candidate size. `fitsAtMax=true` when the ideal `maxPx` fit without shrinking.
- **`wrapTextToBox(text, maxWidthPx, fontSizePx, weight, italic?) → string[]`** — pure greedy word-wrap using `glyphWidthRatio(weight, italic) × fontSizePx` for the per-character width estimate. Part 3: the compositor cares whether text fits a box, not pixel-perfect kerning.
- **`fixOrphans(lines) → string[]`** — pure. Part 3 "no orphans" rule: a 2-letter word alone on the last line reads noob; pull the previous line's last word down.
- **`glyphWidthRatio(weight, italic?) → number`** — pure Helvetica-Neue-ish per-weight glyph-width estimator (900 = 0.62, 700 = 0.56, 300 = 0.48; italic +2%).
- **`planLayout(ratio, w, h, clearZone?) → OverlayLayoutPlan`** — pure per-ratio + scene-aware layout planner. Returns a `safe` rect (from `SAFE_ZONES`), the five element boxes (`headlineBox`/`regretBox`/`benefitBox`/`payoffBox`/`ctaBox`), the two optional scrim rects, and `isColumn` (true for column layouts). Enforces the CTA in the bottom safe band, asymmetric gutters (tight to the product side, generous at the frame edge — Part 3), and full-width center-aligned vs left/right column layouts per `clearZone`.
- **`buildOverlaySVG(copy, ratio, opts?) → string`** — pure, deterministic. Runs `planLayout` → `fitFontToBox` per slot → emits the SVG text layer with legibility scrims and the ratio-appropriate `viewBox`.
- **`compositeCopyOverlay(baseImage, copy, ratio, opts?) → { buffer, mimeType }`** — async. Resizes the base to the ratio's nominal canvas (1080-family), composites the SVG on top via `sharp`, returns jpeg (or png if `outputMime="image/png"`).
- **`escapeXml(s) → string`** — pure. Escapes `& < > " '` so untrusted (AI-authored) copy is safe inside SVG.

Nominal canvas sizes: `4:5 → 1080×1350`, `9:16 → 1080×1920`, `1:1 → 1080×1080`, and the rest of Nano Banana's supported aspect set (see `NanoBananaAspect` in [[gemini]]).

## Phase-3 scope — typography + per-ratio safe zones + scene-aware clear-zone routing

Everything in Part 3 of [[../reference/competitor-ad-adaptation]] baked in as deterministic layout rules rather than pixel offsets:

- **Area-first, then font-to-fit** (`fitFontToBox`) — the caller defines the text box (from `planLayout`), and the fit engine picks the largest font size that fills it. Lines wrap to `maxWidthPx`; no orphan words.
- **Safe-space asymmetry** (`planLayout` column layouts) — column layouts leave the frame-edge margin generous (SAFE_ZONES `sidesPct`) and the gutter to the product tight (`innerGutter ≈ 3% of canvas`). Pinned by a dedicated test.
- **Match the source's type treatment** — headline heavy 900, sub-headline / payoff light 300, benefit stack bold italic 700, CTA 700 in a white pill. Line-height ratios per weight (`1.05` for the heavy headline, `1.2` for lighter body / italic benefit stack).
- **Per-ratio native render** — `SAFE_ZONES` differ per placement (9:16's aggressive 20% bottom band absorbs the Reels chrome; 4:5 keeps 14% every side). Every text/CTA element is planned INSIDE the safe rect.
- **CTA never overlaps a hero element** — the ctaBox lives entirely inside the bottom safe band (bottomPct of the canvas), which by construction is below any hero the text-free scene left centered.
- **Scene-aware clear-zone routing** — `OverlayClearZone` = `top_band` (default, full-width above a centered-low product) / `side_column_left` (product on the right) / `side_column_right` (product on the left). Column layouts left-anchor text; top-band centers it.

## Callers

- [[creative-generate]] `generateCreative` — when `isOverlayRenderModeEnabled()` (i.e. `process.env.DAHLIA_RENDER_MODE === "overlay"`), the flag-gated branch calls `compositeCopyOverlay` on the text-free scene bytes from Nano Banana Pro. Kept opt-in exactly like `DAHLIA_COPY_MODE`: proved-before-default against Bianca's realized cold-audience CAC/CTR, never a rip-and-replace of the legacy model-draws-text path.

## Tests

`src/lib/ads/creative-overlay.test.ts` (Phase 1) — SVG contains the copy strings verbatim (XML-escaped), each ratio maps to the right `viewBox`, `compositeCopyOverlay` returns a valid image whose bytes differ from a plain resize of the untouched base (proof the overlay actually landed), and `outputMime="image/png"` honours the encoding switch.

`src/lib/ads/creative-overlay.phase3.test.ts` (Phase 3) — pins the Meta unified 2026 `SAFE_ZONES` numbers exactly (9:16 = 14/20/6, 4:5 = 14/14/6, 1:1 = 10/10/6), the `fitFontToBox` area-first behaviour (largest font that fits + shrinks on overflow + `fitsAtMax` signal), the no-orphans rule (`fixOrphans` pulls the previous line's last word down), and every `planLayout` invariant (all elements inside the safe rect, CTA nested in the bottom safe band, top-band = full-width center-aligned, side_column_left/right = column layouts, asymmetric gutters — tight to product, generous at frame edge). Also checks the SVG output honours the safe zones (scrimBottom at `h - bottomPct*h`) and the clear-zone hint (`text-anchor="start"` for column, `"middle"` for top-band).
