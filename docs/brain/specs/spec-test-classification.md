# Spec-Test Classification — `fail` needs positive evidence, not "couldn't verify" ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[spec-test-agent]]. Found 2026-06-20: the spec-test agent marked a [[spec-test-json-robustness]] check `fail` → surfaced a phantom **Regression**, when the feature was correct — the check just required **forcing unparseable output** (fault injection) the non-destructive agent can't do.

The agent conflates **"I verified this is broken"** with **"I couldn't verify this read-only."** Only the first is a `fail`. A check that needs fault-injection, forcing a failure, a mutation, or human eyes must be `needs_human`/`inconclusive` — **never `fail`**. Otherwise the "Regressions — shipped but failing its own spec-test" list fills with false alarms and stops meaning anything.

## The rule
- **`fail` requires POSITIVE evidence of breakage** — the agent ran a non-destructive check and observed the feature actually doing the wrong thing (a column it claims is selected isn't; a route 500s; a role check returns the wrong status). No evidence of breakage → it is **not** a `fail`.
- **`needs_human`** — the check is real but the agent can't run it read-only: it needs **forcing a failure / fault injection** (e.g. "force unparseable output → expect `error` state"), a **mutation** (send/charge/create), or **visual/UX** judgment. A human *can* verify it; route it to them.
- **`inconclusive`** — the agent genuinely couldn't determine the outcome and it's unclear a human easily can either (missing fixture, ambiguous bullet). Surfaced, not counted as broken.
- **A regression = a true `fail` only.** The "Regressions" list and the `issues` verdict are driven exclusively by `fail`s backed by breakage evidence; `needs_human`/`inconclusive` never appear there.

## Where
- The **`spec-test` skill** classification guidance (the prompt in `runSpecTestJob` + the skill page): add the above as an explicit rule with the canonical example — *"a bullet that says 'force X to fail → expect error handling' is `needs_human` (you cannot inject the fault read-only), NOT `fail`."* When the agent can read the implementing code and it plainly satisfies the bullet but the runtime path can't be exercised non-destructively, prefer `needs_human` with a note ("code present at file:line; runtime path needs a forced fault to confirm") over `fail`.
- Keep the existing summary guard: `auto_fail` counts only real fails; an empty/uncertain run is never `approved`.

## Verification
- Re-run the [[spec-test-json-robustness]] spec-test → the "force unparseable output → error state" bullet now classifies **`needs_human`** (with a code-present note), **not `fail`** → it leaves the Regressions list and moves to Needs-human.
- A spec with a genuinely broken check (a claimed-selected column that isn't) still classifies `fail` with the probe evidence → still a real regression.
- `needs_human`/`inconclusive` checks never appear under Regressions or flip the verdict to `issues`.

## Phase 1 — classification rule + regression gating ⏳
Tighten the `spec-test` skill's verdict rules (fail = breakage evidence; un-runnable-read-only → needs_human/inconclusive) + ensure the Regressions list / `issues` verdict are driven only by evidence-backed `fail`s. Brain: [[spec-test-agent]] + the `spec-test` skill page + [[../dashboard/spec-tests]]. Fold on ship.
