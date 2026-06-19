# `src/lib/blog/generate-images.ts` — branded blog imagery (NBP + WebP)

Step 3 of the auto-blog pipeline ([[../lifecycles/auto-blog-generation]]). Generates the hero + in-body + 4:5 social images, compresses every output to WebP, and uploads to our storage. Wraps [[gemini]] `generateNanoBananaProCombine` (`gemini-3-pro-image`) + `sharp`.

## Exports

| Export | Shape | Notes |
|---|---|---|
| `compressToWebp(buffer, maxWidth?)` | `→ Buffer` | sharp → WebP @ ≤1600px (default). Measured: 631KB JPEG → 66KB WebP (~14× page-weight cut). Also reused by the advertorial `reasons` hero ([[../lifecycles/advertorial-landers]]). |
| `genCompressUpload({ workspaceId, handle, slot, prompt, imageUrls?, aspectRatio? })` | `→ { url }` | NBP generate → `compressToWebp` → `uploadPostImage`. `imageUrls=[isolated pouch]` → composite hero (real label intact); `imageUrls=[]` → text-to-image in-body shot. |
| `genSocialVariant({ workspaceId, handle, prompt })` | `→ { url }` | Re-renders the hero scene at **4:5 portrait (1080×1350)** → `posts.social_image_url` (what the social poster posts; never shown on the blog). |
| `uploadPostImage({ workspaceId, handle, slot, buffer })` | `→ { url }` | Uploads to `product-media` at `workspaces/{ws}/posts/{handle}/{slot}.webp`. |
| `SLOT_MAX_WIDTH` | `Record<string,number>` | Per-slot max width (hero vs in-body). |

## Gotchas
- **Aspect must be forced** — without NBP's `imageConfig.aspectRatio` the model drifts to square. The hero is rendered 16:9, the social variant 4:5 (the tallest IG/FB feed ratio → most vertical real estate). *(History: 4:5 → 4:3 2026-06-12 → 4:5 2026-06-16.)*
- **Isolated pouch input** comes from `product_variants.image_url` (our storage), NOT the Shopify-CDN `products.variants` JSON.
- **WebP quick-win only** — the full AVIF/WebP multi-width `<picture>`/srcset pipeline (reuse [[image-transcode]]) is the remaining bigger win.

## Callers
- [[../inngest/auto-blog]] — step 3 of the daily run.
- `src/lib/advertorial-pages.ts` `ensureReasonsHero` reuses `compressToWebp` for the "8 Reasons Why" lander hero ([[../lifecycles/advertorial-landers]]).

## Related
[[../lifecycles/auto-blog-generation]] · [[gemini]] · [[image-transcode]] · [[blog__write-post]] · [[../tables/posts]] · [[../lifecycles/advertorial-landers]]
