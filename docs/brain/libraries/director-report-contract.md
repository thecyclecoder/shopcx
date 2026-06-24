# libraries/ceo-mode/director-report-contract

The **CEO-mode director report contract** — the standard output schema every specialist director
(CFO, Growth, CMO, Retention, Logistics, CS) returns so the **CEO synthesizer** can compose them
([[../goals/ceo-mode]] § "The org model", **M0**). This is the schema-as-code of the shape the goal
doc specifies:

```
{ domain, health_score, metrics_vs_target[],
  findings[],
  recommended_actions[{ action, expected_impact_$, effort, confidence, reversible?, depends_on }],
  risks[] }
```

The first **producer** is the Growth director ([[growth-report-contract]]); the first **reader** is the
M4 CEO synthesizer (still planned). This module is the shared shape they meet on — so directors target
the *final* schema and the synthesizer validates what it composes.

**File:** `src/lib/ceo-mode/director-report-contract.ts`

## North star

Per [[../../CLAUDE]] § North star and [[../goals/ceo-mode]] § "Role agents own the objective", the
contract carries the supervision signal, not just the numbers: `objective` (what the agent owns),
`proxy` (the bounded metric it reasons on — named so a proxy-move is legible), and `assumptions` (the
versioned methodology behind every value). A degenerate proxy-move surfaces as a `risk`, never as a
silently-executed `recommended_action`.

## Exports

### `DirectorReportContract` — interface
`domain`, `health_score` (0–100), `metrics_vs_target[]`, `findings[]`, `recommended_actions[]`,
`risks[]`, plus north-star extensions `objective?`, `proxy?`, `assumptions?[]`, `window?`.

### Supporting types
- `MetricVsTarget` — `{ metric, value|null, target|null, unit, status, delta|null, note? }`.
  `status: "above" | "at" | "below" | "unknown"`.
- `Finding` — `{ summary, detail?, severity, evidence? }`. `severity: "info" | "watch" | "risk"`.
- `RecommendedAction` — `{ action, expected_impact_usd|null, effort, confidence, reversible, depends_on[] }`.
  `expected_impact_usd` is the goal doc's `expected_impact_$`. `effort`/`confidence: "low" | "medium" | "high"`.
- `Risk` — `{ summary, severity, mitigation? }`. `severity: "low" | "medium" | "high"`.
- Enums: `DirectorEffort`, `DirectorConfidence`, `MetricStatus`, `FindingSeverity`, `RiskSeverity`.

### `validateDirectorReportContract(input): { valid, errors[] }` — function
Runtime-validates an arbitrary object against the contract, returning **every** violation (not just the
first) so a director's output can be gated before it reaches the CEO synthesizer. Checks required
fields, types, numeric ranges (`health_score` ∈ [0,100]), and enum membership.

## Callers

- [[growth-report-contract]] `buildGrowthReportContract` — the first director to emit the contract.
- (planned) the M4 CEO synthesizer — validates + composes each director's report.

## Gotchas

- **`expected_impact_usd` ↔ goal doc `expected_impact_$`.** Renamed for a code-safe key; same meaning.
- **`health_score` is 0–100**, not 0–10 and not a ratio — the validator enforces the range.
- The north-star extension fields (`objective`/`proxy`/`assumptions`/`window`) are optional in the
  validator but every real director should populate them — they're the supervision signal.

---

[[../README]] · [[../../CLAUDE]] · [[../goals/ceo-mode]]
