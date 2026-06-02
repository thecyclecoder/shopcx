# inngest/review-tagging

Tags `product_reviews` with `featured` / topic clusters via Haiku.

**File:** `src/lib/inngest/review-tagging.ts`

## Functions

### `reviews/tag-cancel-relevance`
- **Trigger:** event `reviews/tag-cancel-relevance`
- **Concurrency:** `concurrency: { limit: 1 }`


### `reviews/tag-cancel-relevance-cron`
- **Trigger:** cron `0 4 * * 1`
- **Concurrency:** `concurrency: { limit: 1 }`


## Downstream events sent

_None._

## Tables written

- [[../tables/product_reviews]]

## Tables read (not written)

- [[../tables/workspaces]]

## Header notes

```
Inngest functions for tagging product reviews with cancel-relevance
Uses Claude Haiku to analyze which cancel reasons each review helps counter
```

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
