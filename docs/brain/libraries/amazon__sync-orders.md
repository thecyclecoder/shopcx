# libraries/amazon/sync-orders

Amazon SP-API order pull.

**File:** `src/lib/amazon/sync-orders.ts`

## File header

```
Amazon order sync: request report → poll → parse TSV → upsert daily snapshots
```

## Exports

### `requestReport` — function

```ts
async function requestReport(connectionId: string, marketplaceId: string, startDate: string, endDate: string,) : Promise<string>
```

### `pollReportStatus` — function

```ts
async function pollReportStatus(connectionId: string, marketplaceId: string, reportId: string,) : Promise<
```

### `downloadReport` — function

```ts
async function downloadReport(connectionId: string, marketplaceId: string, documentId: string,) : Promise<string>
```

### `processOrderReport` — function

```ts
async function processOrderReport(params: { workspaceId: string; connectionId: string; reportTsv: string; }) : Promise<
```

## Callers

- `src/lib/inngest/amazon-sync.ts`
- `src/lib/inngest/today-sync.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
