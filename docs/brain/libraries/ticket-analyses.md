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

### `refuteAnalysisIssue` — async function

```ts
async function refuteAnalysisIssue(input: {
  analysisId: string;
  workspaceId: string;
  issueIndex: number;
  reason: string;
  refutedBy: string;
}): Promise<{ ok: boolean; error: string | null }>
```

Stamps ONE element of `ticket_analyses.issues[]` as refuted — adding `refuted_at`, `refuted_by`, and `refutation_reason` on the target element (JSONB, no migration required). The single writer for the per-issue refutation channel introduced by spec `refuted-qc-findings-must-be-marked-not-just-argued`: without it, a disproven finding can only be argued in prose on the ticket thread and every downstream reader keeps citing the void entry (ground truth: ticket b28e7744, where two 'inaccuracy' findings were refuted in an internal note that same afternoon but the analysis row was never touched, and four hours later the CS director cited the same substance and re-escalated to the founder).

Semantics:
- **Bounds-checked**: `issueIndex >= issues.length` returns `{ ok: false, error }`, never a silent no-op.
- **Idempotent**: refuting an already-refuted entry preserves the original `refuted_at` / `refuted_by` / `refutation_reason` — a re-run does NOT overwrite the audit trail.
- **Compare-and-set**: `.eq('id', analysisId).eq('workspace_id', workspaceId).select('id')` — exactly one row must transition; a cross-workspace id sneak fails cleanly.
- Distinct from `applyAdminOverride` (which writes a whole-row admin score + reason) — the score-override and a per-issue verdict are different facts, and overloading `applyAdminOverride` would conflate them.

### `activeIssues` — pure function

```ts
function activeIssues(row: { issues: TicketAnalysisIssue[] | null | undefined }): TicketAnalysisIssue[]
```

Returns only issues whose `refuted_at` is null. The accessor every DECIDING consumer switches to (Phase 2 of the same spec: `coraIssuesToMessySignals`, `selectResearchRecipes`, the reopen/escalate branch, and the daily-analysis-report rollup). Rule of thumb: a surface that DECIDES filters refuted out; a surface that DISPLAYS the audit trail keeps them and marks them.

### Refutation carry-forward rule on `applyAgentRescore`

`applyAgentRescore` (agent-authored rescore from the escalation-triage approved todo) REPLACES `issues[]` wholesale. Left alone, that would silently drop refutations recorded by `refuteAnalysisIssue` — reviving a finding a reviewer already disproved. The SDK now guards against this:

1. Reads the existing row's `issues` before writing.
2. For every prior element with `refuted_at != null`, the refutation fields (`refuted_at`, `refuted_by`, `refutation_reason`) are carried forward onto the same index of the new array.
3. If the new array is SHORTER than the highest refuted index, the write is REFUSED (`{ ok: false, error }`). The caller must include a slot for every refuted entry.

Same rule applies to any future issues[]-replacing writer added to this SDK.

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
