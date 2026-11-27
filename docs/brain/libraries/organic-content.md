# src/lib/social/organic-content.ts

The **write chokepoint** for the organic social library ([[../tables/organic_content]]) — the organic feed never reaches back into the ads system, and a wrong column can't silently write empty (CLAUDE.md "raw `.from` with no SDK → STOP"). Added in organic-nugget-engine Phase 1.

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `listApprovedOrganicContent` | `(admin, workspaceId, opts?: { format? }) → Promise<OrganicContent[]>` | approved assets the scheduler may post, newest first; optional `format` filter (e.g. `carousel`) |
| `getOrganicContent` | `(admin, workspaceId, id) → Promise<OrganicContent \| null>` | one asset by id, workspace-scoped |
| `insertOrganicContentDraft` | `(admin, workspaceId, input: InsertOrganicDraftInput) → Promise<OrganicContent>` | inserts status=`draft` unless `input.status` overrides (review mover passes `approved`) |
| `setOrganicContentStatus` | `(admin, workspaceId, id, status) → Promise<void>` | approve a draft / retire an asset |
| `listQueuedOrganicContent` | `(admin, workspaceId, format) → Promise<OrganicContent[]>` | draft-or-approved of a format — the nugget queue + title-dedupe source |
| `existingOrganicReviewIds` | `(admin, workspaceId) → Promise<Set<string>>` | review_ids that already have an organic card — idempotency read for the review mover |

Types: `OrganicFormat` (`carousel`\|`reel`\|`review`), `OrganicPillar` (`body`\|`food_first`\|`superfoods`), `OrganicStatus` (`draft`\|`approved`\|`retired`), `OrganicSlide`, `OrganicContent`.

## Callers

- [[featured-review-cards]] — `existingOrganicReviewIds` (idempotency) + `insertOrganicContentDraft` (format=`review`, status=`approved`).
- [[nugget-generator]] — `listQueuedOrganicContent` (queue + dedupe) + `insertOrganicContentDraft` (format=`carousel`, status=`draft`).
- `src/lib/social/organic-reels.ts` `ingestOrganicReel` — `insertOrganicContentDraft` (format=`reel`, status=`draft`) from the operator "Add reel" upload.
- `src/lib/social/resources.ts` `pickOrganic` + `src/lib/social/publish.ts` (`getOrganicContent` to resolve carousel slides) — `listApprovedOrganicContent` / `getOrganicContent` (the scheduler reads organic content ONLY from here).

## Enforcement

`scripts/_check-organic-content-sdk-compliance.ts` (npm `check:organic-content-sdk-compliance`, chained into `predeploy:static`) fails on any raw `.from('organic_content').insert/update/upsert/delete` outside this file.

## Related

[[../tables/organic_content]] · [[featured-review-cards]] · [[../lifecycles/social-scheduler]] · [[../README]]
