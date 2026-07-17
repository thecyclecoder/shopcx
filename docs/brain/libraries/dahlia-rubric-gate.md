# `src/lib/ads/dahlia-rubric-gate.ts`

Phase 3 of [[../specs/dahlia-researches-from-winners-flow-ad-library]] — the **ready-to-bin quality gate** that reads Max's Phase-2 5-axis rubric composite (0..10) against the per-workspace threshold and decides whether to insert the creative into Bianca's ready-to-test bin, revise it (feed the per-axis reasons back to Dahlia), or escalate (bounded-retry exhausted).

Rejected-only at 7/10 with a grader that starts at 5–6 would leave the bin EMPTY — nothing ships until Max blesses it, but Max is calibrating. **Revise-to-pass** fills the bin with genuinely good creative; a **tunable threshold** lets the bar rise as Dahlia's quality climbs.

## Surface

- **`computeDahliaRubricComposite(rubric)`** — pure. Sums the five [[creative-qa|DahliaCreativeRubric]] axis scores, averages, rounds to the nearest integer (0..10). The composite is the AVERAGE (rounded), NOT the sum — so a threshold of 7 means "each axis averaged ≥7," which is the intuitive reading of "≥7/10 composite" in the spec.
- **`collectAxisMisses(rubric, threshold)`** — pure. Returns the axes that scored strictly below the threshold, ordered worst-first (score ASC), preserving `DAHLIA_RUBRIC_AXES` order on ties. Feeds the revise-loop prompt back to Dahlia so she can address the biggest misses first.
- **`evaluateReadyToBinGate({ rubric, threshold, attemptIndex, maxReviseAttempts? })`** — pure. Discriminated outcome:
  - **`{ kind: "bin", composite }`** — composite ≥ threshold → flip to `ad_campaigns.status='ready'`.
  - **`{ kind: "revise", composite, misses, nextAttemptIndex }`** — composite < threshold, cap not spent → feed axis misses back to Dahlia, regenerate, re-QC.
  - **`{ kind: "exhausted", composite, misses }`** — cap spent → the caller escalates via `director_activity` `action_kind='dahlia_rubric_gate_exhausted'` and HOLDS the campaign out of the bin (never silently downgrades to `draft`).
- **`resolveDahliaRubricMinComposite(admin, workspaceId)`** — async, FAIL-CLOSED. Reads `iteration_policies.dahlia_rubric_min_composite` newest-first (same convention as `resolveLf8UnderperformanceThreshold` in [[ads-supervisor]]). Read error / missing row → `{ ok: false, reason }`; null column value → `DAHLIA_RUBRIC_MIN_COMPOSITE_DEFAULT` (7).
- **`MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS = 3`** — const. Total sanctioned pass count = `1 + MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS`. Caller may override via `maxReviseAttempts`.
- **`DAHLIA_RUBRIC_MIN_COMPOSITE_DEFAULT = 7`** — the spec's opening bar. Mirrors the `iteration_policies.dahlia_rubric_min_composite` column DEFAULT.

## Fail-closed reader (why)

`resolveDahliaRubricMinComposite` mirrors [[ads-supervisor]] `resolveLf8UnderperformanceThreshold` — a Supabase read error OR a missing `iteration_policies` row returns `{ ok: false, reason }`. The Phase-3 gate MUST refuse to auto-bin on an unproven threshold: silently falling back to a hardcoded 7 would let a workspace with a raised threshold (e.g. tuned to 8 for a high-baseline Dahlia) accept sub-bar creatives. The caller's exhaustion policy takes over.

## Wiring (M1 dispatcher — currently seam)

The pure gate + reader are shipped in Phase 3 so they can be pinned by their own vitest independent of the still-moving M1 keystone Node dispatcher for `runQaCreativeCopyViaBoxSession` in [[creative-qa]] (which currently exists as the pre-check + prompt runner, awaiting the top-level cadence job in `scripts/builder-worker.ts` to actually spawn the child). When that dispatcher lands, its per-attempt loop reads:

```ts
const gate = await resolveDahliaRubricMinComposite(admin, workspaceId);
if (!gate.ok) return { kind: "escalate", reason: gate.reason };
const outcome = evaluateReadyToBinGate({
  rubric: verdict.dahlia_rubric,
  threshold: gate.value,
  attemptIndex,
});
switch (outcome.kind) {
  case "bin":       return insertReadyCreative(…);
  case "revise":    return runCopyAuthorSession({ …, reviseReason: buildAxisMissesPrompt(outcome.misses) });
  case "exhausted": return escalateDahliaRubricGateExhausted(admin, { workspaceId, campaignId, composite: outcome.composite });
}
```

The **ledger** already records each attempt via [[creative-qa]] `insertCopyQaVerdict` (Phase 2 — the `retry_index` column + the `dahlia_rubric` payload land per QC attempt); Phase 3 doesn't add a new writer.

## Migration

`supabase/migrations/20261103120000_iteration_policies_dahlia_rubric_min_composite.sql` — additive `ADD COLUMN IF NOT EXISTS dahlia_rubric_min_composite integer not null default 7`. Auto-applied post-merge by the Control Tower migration-drift reconciler (`classifyMigrationSql` → additive → auto-apply). Paired apply script `scripts/apply-iteration-policies-dahlia-rubric-min-composite-migration.ts` for operator re-apply + classifier re-tagging.

## Tests

`src/lib/ads/dahlia-rubric-gate.test.ts` (13 cases): every spec-verification predicate pinned — `<threshold` triggers revise (P3-1), `≥threshold` triggers bin (P3-2), threshold reads from the setpoint (P3-3), bounded retries cap the loop (P3-4), fail-closed on read error / missing row, plus pure helpers (composite average + rounding + worst-first miss ordering).

## Related

[[creative-qa]] · [[creative-agent]] · [[iteration_policies]] · [[ads-supervisor]] · [[../specs/dahlia-researches-from-winners-flow-ad-library]]
