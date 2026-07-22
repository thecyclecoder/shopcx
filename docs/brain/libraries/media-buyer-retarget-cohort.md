# media-buyer-retarget-cohort

`src/lib/media-buyer/retarget-cohort.ts` — the SDK chokepoint for [[../tables/media_buyer_retarget_cohorts]], the Media Buyer's THIRD (retarget) campaign configuration ([[../specs/retarget-campaign-warm-hot-mixed-content]] Phase 1).

Sibling of the cold-rail cohort resolver in [[media-buyer-publish-gate]] (`getEffectiveMediaBuyerTestCohort`), but for the WARM + HOT MIXED retarget rail: ONE lean consolidated adset, its own `audience_temperatures` whitelist (default `['warm','hot']`), never touching the cold-only invariant of Bianca's replenish loop.

## Exports

| Export | Signature | Purpose |
|---|---|---|
| `RetargetTemperature` | `"warm" \| "hot"` | The bands the retarget rail carries. |
| `DEFAULT_RETARGET_TEMPERATURES` | `readonly ["warm","hot"]` | The default mix (mirrors the migration's `default '{warm,hot}'`). |
| `RetargetCohort` | interface | Camel-cased row shape (`bigint` → `number`). |
| `getEffectiveRetargetCohort` | `(admin, workspaceId, { metaAdAccountId?, productId? }) => Promise<RetargetCohort \| null>` | Resolve the most-specific active cohort for a (workspace, account, product) tuple. |
| `provisionRetargetCohort` | `(admin, opts) => Promise<{ cohortId, publishIdentity }>` | Idempotent upsert of one active cohort; delegates identity to `resolvePublishIdentity`. |

### `getEffectiveRetargetCohort`

Resolution order (identical to the cold cohort resolver): the product-specific `(account, productId)` row wins, then the null-product account default, then the workspace-wide null-account default. Returns `null` when no active row exists (the retarget gate then REFUSES the publish — no configured cohort = no autonomous retarget go-live). `productId` is optional; omitting it returns the null-product account default so a workspace with no product dimension behaves identically.

### `provisionRetargetCohort`

Idempotent on `(workspace, account, product)`: retires any prior active row for the scope (via `.eq`/`.is` on the nullable account + product), then inserts fresh. It **references/calls [[media-buyer-publish-identity]] `resolvePublishIdentity`** up front — a mis-scoped workspace throws BEFORE any write, so a retarget cohort can never be provisioned under the wrong Facebook Page / Instagram identity (the same canonical-identity rail the cold rail's `buildReplenishJobInsert` honors). Creates NO Meta objects and spends nothing — the caller supplies the already-created retarget campaign + consolidated adset ids.

## Callers

- [[media-buyer-retarget-publish-gate]] `evaluateMediaBuyerRetargetPublish` — reads the effective cohort on every `origin='media-buyer-retarget'` publish.
- [[media-buyer-retarget-agent]] `runRetargetReplenishPass` — resolves the cohort, then reads warm/hot ready creatives against its `audienceTemperatures` whitelist.

## Related

[[../tables/media_buyer_retarget_cohorts]] · [[media-buyer-publish-identity]] · [[media-buyer-publish-gate]] · [[media-buyer-retarget-publish-gate]] · [[media-buyer-retarget-agent]] · [[../inngest/media-buyer-retarget-cadence]] · [[../specs/retarget-campaign-warm-hot-mixed-content]] · [[../functions/growth]]
