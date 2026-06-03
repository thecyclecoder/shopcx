# Ad-tool Remotion compositions

Server-side video + static render target for the ad tool. **Excluded from the
app's `tsconfig.json`** — it has its own dependency set and is invoked at render
time via a dynamic import in `src/lib/ad-render.ts → renderAdFormat()`.

## Install (required before video render works)

```
npm i remotion @remotion/bundler @remotion/renderer @remotion/cli
```

The Anton font (Hormozi captions) is loaded by the composition; bundle it via
`@remotion/google-fonts/Anton` or self-host under `remotion/fonts/`.

## Compositions

- `AdComposition` — the video MP4. Layers: cut track (talking-head + b-roll per
  `cutPlan`) → ingredient pops → Hormozi captions → credibility row.
- `AdStatic` — one still JPG per format (shipping-label brutalist default).

`src/lib/ad-render.ts` calls `selectComposition` by id, passes `inputProps`
(the output of `buildCompositionProps`), and renders via `renderMedia` /
`renderStill`. It is called ONCE per format (Reels MP4, Feed-4:5 MP4, Stories
JPG, Feed-4:5 JPG) → 4 `ad_videos` rows linked by `format_variant_of_id`.

## Preview locally

```
npx remotion studio remotion/index.ts
```

## Safe zones

Every readable element (captions, badges, headline, proof, guarantee) is
positioned inside `props.safeCore`. `ad-render.ts → validateSafeZone()` asserts
this before encode; the props' `safeCore` is computed per format + media kind in
`src/lib/ad-tool-config.ts`.
