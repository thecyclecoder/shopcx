# libraries/daily-analysis-report

Generates daily AI analysis reports.

**File:** `src/lib/daily-analysis-report.ts`

## File header

```
Daily AI Analysis Report generator.
Aggregates a day's ticket_analyses into a written report with:
- Narrative summary (themes, severity, signal)
- Themes (clustered failure modes with ticket IDs)
- Proposed sonnet_prompts (rules for the AI agent)
- Proposed grader_prompts (calibration rules for the analyzer)
The proposed rules are inserted into their respective tables with
status='proposed' so they show up in the existing approval queues at
Settings → AI → Prompts and Settings → AI → Grader Rules. The
daily_analysis_reports row stores the IDs so the report UI can show
"View proposed rule →" links.
Run by cron (6 AM Central, covers yesterday) or on-demand via API.
```

## Exports

### `generateDailyReport` — function

```ts
async function generateDailyReport(workspaceId: string, date: string, trigger: "cron" | "manual" | "backfill" = "cron", generatedBy: string | null = null,) : Promise<GenerateResult>
```

## Callers

- `src/app/api/workspaces/[id]/daily-analysis-reports/route.ts`
- `src/lib/inngest/daily-analysis-report-cron.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
