# inngest/scrape-help-center

Crawler that imports an existing help-center site into `knowledge_base`. Used for the Gorgias → ShopCX migration.

**File:** `src/lib/inngest/scrape-help-center.ts`

## Functions

### `kb-scrape-help-center`
- **Trigger:** event `kb/scrape-help-center`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`


## Downstream events sent

- `kb/document.updated`

## Tables written

- [[../tables/knowledge_base]]

## Tables read (not written)

- [[../tables/products]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
