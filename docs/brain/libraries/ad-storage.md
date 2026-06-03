# libraries/ad-storage

Ad tool — private Supabase Storage helpers. Reference photos, generated audio, intermediate clips, and final renders all live in the **private** `ad-tool` bucket. Higgsfield needs publicly-readable inputs, so we hand it short-lived signed URLs (1h) at call time rather than making anything public.

**File:** `src/lib/ad-storage.ts` · See [[higgsfield]], [[ad-render]], [[../inngest/ad-tool]].

## Exports

| Export | Purpose |
|---|---|
| `AD_BUCKET = "ad-tool"` | the private bucket name |
| `SIGNED_TTL_SEC = 3600` | 1h — comfortably longer than any job |
| `uploadFromUrl(path, sourceUrl, contentType)` | fetch a remote asset (e.g. a Higgsfield output URL) into the bucket |
| `uploadBuffer(path, buffer, contentType)` | upload an in-memory buffer (final renders) |
| `signedUrl(path, ttlSec = 3600)` | short-lived signed URL for Higgsfield inputs + UI previews |
| `ensureAdBucket()` | idempotently create the private bucket (200MB file limit) — called by the apply script |

## Gotchas

- The bucket is **private** (`public:false`). Never make it public — always mint a signed URL.
- Uploads use `upsert:true`, so re-running a stage overwrites the prior asset at the same path.

---

[[../README]] · [[../../CLAUDE]]
