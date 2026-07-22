# publish-adset-unavailable-classifier

Meta Graph error classifier for permanent ad-set configuration problems.

**File:** `src/lib/ads/publish-adset-unavailable-classifier.ts`

## Exports

### `STALE_ADSET_FAILURE_REASON`
Constant: `"meta_adset_unavailable"`. The stable failure reason string written to [[../tables/ad_publish_jobs]] when the target ad set is unavailable.

### `isMetaAdsetUnavailableError(err: unknown): boolean`
Classifies a Meta Graph error thrown from `createAd` as a permanent ad-set configuration problem (deleted, archived, or permission-denied) vs. a transient platform issue.

**Error signals recognized:**
- Graph subcode 33 — "Object does not exist / cannot be loaded due to missing permission / does not support this operation" (canonical).
- Meta error codes 200 or 803 — explicit permission-denied responses.
- HTTP 400 status with message containing "does not exist" / "cannot be loaded" / "missing permission" (message-shape fallback for Graph responses that don't surface a subcode).

**Used by:** [[../inngest/ad-tool]] `ad-tool-publish-to-meta` function in its `createAd` catch block; on match, the publish job is marked `failed` with reason `meta_adset_unavailable` and the step returns normally instead of rethrowing, preserving visibility without triggering `/api/inngest` exceptions or Control Tower incidents.

---

[[../README]] · [[../inngest/ad-tool]] · [[../libraries/meta-ads]]
