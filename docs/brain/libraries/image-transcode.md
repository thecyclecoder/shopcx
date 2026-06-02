# libraries/image-transcode

Image resizing + transcoding for product media.

**File:** `src/lib/image-transcode.ts`

## File header

```
Upload-time image transcoding + responsive variants.
Takes whatever the admin uploaded and emits:
- a normalized original (EXIF stripped, rotated, clamped)
- AVIF + WebP at each of three widths (640, 1200, 1920)
These variants back a native <picture>/<source srcset> element on
the storefront. Because every file is pre-encoded, the hero image
can be served directly from object storage — no runtime optimizer,
no serverless cold start, no cascading origin miss.
Why pre-transcode vs Vercel /_next/image:
1. Public URLs (og bots, crawlers) see AVIF directly, never the
raw PNG.
2. No cold-cache penalty on low-traffic pages — every variant
already exists at its final URL.
3. Strips EXIF + downscales runaway uploads server-side.
```

## Exports

### `transcodeUpload` — function

```ts
async function transcodeUpload(input: Buffer, sourceMime: string,) : Promise<TranscodedImage>
```

### `RESPONSIVE_WIDTHS` — const

```ts
const RESPONSIVE_WIDTHS
```

### `ResponsiveVariant` — interface

### `TranscodedImage` — interface

### `ResponsiveWidth` — type

## Callers

- `src/app/api/workspaces/[id]/products/[productId]/media/[slot]/route.ts`
- `src/app/api/workspaces/[id]/storefront-design/logo/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
