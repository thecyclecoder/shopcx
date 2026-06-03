# inngest/customer-demographics

Enriches `customer_demographics` from Census + Versium for new customers. End-to-end pipeline in [[../lifecycles/demographic-enrichment]].

**File:** `src/lib/inngest/customer-demographics.ts`

## Functions

### `demographics-enrich-batch`
- **Trigger:** event `demographics/enrich-batch`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1 }]`


### `demographics-enrich-single`
- **Trigger:** event `demographics/enrich-single`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 10, key: "event.data.workspace_id" }]`


### `demographics-snapshot-builder`
- **Trigger:** event `demographics/rebuild-snapshots`
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/customer_demographics]]
- [[../tables/customers]]
- [[../tables/demographics_snapshots]]

## Tables read (not written)

- [[../tables/orders]]
- [[../tables/products]]
- [[../tables/subscriptions]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
