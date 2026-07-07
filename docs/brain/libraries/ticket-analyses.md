# libraries/ticket-analyses

Typed SDK for per-ticket AI analysis records. Mirrors the specs-table PM SDK pattern ([[../libraries/specs-table]]) — all [[../tables/ticket_analyses]] reads and writes flow through this SDK, never raw `.from('ticket_analyses')` mutations. Enforced by compliance check [scripts/_check-pm-sdk-compliance.ts](https://github.com/thecyclecoder/shopcx/blob/main/scripts/_check-pm-sdk-compliance.ts).

**File:** `src/lib/ticket-analyses.ts`

## Exports

### `getAnalysis` — async function

```ts
async function getAnalysis(ticketId: string): Promise<TicketAnalysis | null>
```

Fetches the most recent analysis for a ticket.

### `insertAnalysis` — async function

```ts
async function insertAnalysis(data: {
  workspace_id: string,
  ticket_id: string,
  window_start: Date,
  window_end: Date,
  score: number,
  issues: AnalysisIssue[],
  action_items: string[],
  summary: string,
  model: string,
  input_tokens: number,
  output_tokens: number,
  trigger: string,
  ai_message_count: number
}): Promise<TicketAnalysis>
```

Inserts a new analysis row. Called by `scripts/builder-worker.ts → runTicketAnalyzeJob` after the Max session completes and before any downstream severity actions.

### `listForTicket` — async function

```ts
async function listForTicket(ticketId: string): Promise<TicketAnalysis[]>
```

Fetches all analyses for a ticket, ordered by creation time.

### `updateAnalysis` — async function

```ts
async function updateAnalysis(
  id: string,
  data: Partial<TicketAnalysis>
): Promise<TicketAnalysis>
```

Updates an existing analysis (e.g., admin score override). Idempotent on unchanged rows.

## Callers

- `scripts/builder-worker.ts → runTicketAnalyzeJob` — the box worker dispatches ticket analysis, runs the Max session, calls `insertAnalysis` to write the verdict, then `applySeverityActions` (in [[../libraries/ticket-analyzer]]) to apply escalation rules and write [[../tables/director_activity]]
- Dashboard admin corrections — uses `updateAnalysis` to record manual score overrides
- `src/lib/inngest/ticket-analysis-cron.ts` — enqueues analysis jobs (still cron-driven; the analysis itself runs as a box session)

## Compliance

[[scripts/_check-pm-sdk-compliance.ts](https://github.com/thecyclecoder/shopcx/blob/main/scripts/_check-pm-sdk-compliance.ts)] forbids raw `.from('ticket_analyses').insert/update/delete/upsert` outside this SDK. Any CI-caught violation flags a lint error.

## Related

[[../libraries/ticket-analyzer]] · [[../tables/ticket_analyses]] · [[../functions/cs]] · [[../libraries/director-activity]]

---

[[../README]] · [[../../CLAUDE]]
