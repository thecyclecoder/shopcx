# inngest/import-subscriptions

One-off bulk pull from Appstle for the initial subscription import / re-sync.

**File:** `src/lib/inngest/import-subscriptions.ts`

## Functions

### `import-file-upload`
- **Trigger:** event `import/file.upload`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`


### `import-file-split`
- **Trigger:** event `import/file.split`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`


### `import-chunk-process`
- **Trigger:** event `import/chunk.process`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 10, key: "event.data.workspace_id" }]`


### `import-chunks-complete`
- **Trigger:** event `import/chunks.complete`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`


### `import-finalize-batch`
- **Trigger:** event `import/finalize.batch`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 10, key: "event.data.workspace_id" }]`


### `import-job-complete`
- **Trigger:** event `import/job.complete`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/customers]]
- [[../tables/import_jobs]]
- [[../tables/orders]]
- [[../tables/subscriptions]]

## Tables read (not written)

- `imports`

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
