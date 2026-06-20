# Spec-Test JSON Robustness (no silent "no parseable JSON" runs) ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[spec-test-agent]]. Found 2026-06-20: a run for `improve-queue-mark-read` showed **"agent produced no parseable JSON"** — 0 checks, no verdict.

`runSpecTestJob`'s Max session sometimes returns prose instead of the structured result, so the run records zero checks and a useless state. Make the contract strict + self-repairing so a run either yields a real verdict or a clearly-retryable error — never a silent empty run that reads like "tested, nothing found."

## Fix
- **Strict output contract** — the `spec-test` skill must emit **only** the result JSON (the `{agent_verdict, summary, checks[]}` shape), fenced/last-line, no prose around it. Tighten the skill prompt + give an explicit schema + a one-shot example.
- **Parse + repair loop** in `runSpecTestJob`: extract the JSON (last fenced block / last `{...}`); on parse failure, **re-prompt once** ("return ONLY valid JSON matching this schema, no commentary") before giving up. Tolerate trailing prose by scanning for the last valid JSON object.
- **Honest terminal state** — if still unparseable after the repair pass, write the run as **`error`** (a distinct state), not a 0-check `approved`/empty row. The Developer page shows it as **"Run errored — retry"** with the raw tail, and **Test now** re-runs it. An empty/zero-check run must never display as a clean pass.
- **Guard the summary math** — `auto_pass/auto_fail/needs_human` derive from `checks[]`; an empty `checks[]` can't yield `approved` (no checks ≠ passed).

## Verification
- Force the agent to emit prose + JSON → the runner extracts the JSON and records a real verdict.
- Force unparseable output → after one repair re-prompt it still fails → the run is `error` (not approved/empty), shows "retry" on the Developer page, and **Test now** re-runs.
- Re-run the `improve-queue-mark-read` spec-test → it produces a parseable verdict with real checks.

## Phase 1 — strict contract + parse-repair + error state ⏳
Skill output contract + `runSpecTestJob` parse/repair/retry + the `error` terminal state + Developer-page "retry" rendering + summary-from-checks guard. Brain: [[spec-test-agent]] + the `spec-test` skill page + [[../tables/spec_test_runs]]. Fold on ship.
