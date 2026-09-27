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

## Exports

### `upsertWorkspaceDemographicsSnapshot(row: WorkspaceSnapshotRow): Promise<void>`
Upserts the all-customers demographics summary snapshot (`product_id IS NULL`) for a workspace. Handles the uniqueness constraint correctly by querying for an existing row with matching `workspace_id` and `product_id IS NULL`, then updating or inserting as appropriate. Used by `demographics-snapshot-builder` to refresh the workspace-wide snapshot without triggering Postgres conflict errors on a non-existent full-table unique constraint.

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
