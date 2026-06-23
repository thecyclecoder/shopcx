# Coverage auto-register agent — close Control Tower coverage gaps automatically ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends the [[control-tower-complete-coverage|coverage self-audit]] + mirrors [[repair-agent]] (detect → propose fix). · **Found in use 2026-06-23:** the coverage self-audit keeps surfacing **unregistered loops** — a cron `createFunction` served in code but absent from `MONITORED_LOOPS` (currently `storefront-ltv-reconcile-cron` + `storefront-optimizer-cron`; before them, the storefront-experiments + lever-decay crons). Each time the owner (or I) hand-adds the registry entry. That's a mechanical fix the system should propose itself.

The self-audit already *detects* the gap (it lists each unregistered loop with its cron schedule). What's missing: an agent that, on a detected gap, **authors the `MONITORED_LOOPS` entry** and surfaces it for one-tap Build (never silently — adding a monitored loop sets an alerting contract, so the owner picks the owner-function + cadence/window).

## Model (mirror the repair agent)
- **Trigger:** a detected unregistered loop in the coverage self-audit (event-driven on the audit, not a blind cron).
- **It authors the fix:** a single-phase spec (or a direct `registry.ts` patch surfaced as a `build`) that adds the `MONITORED_LOOPS` entry — inferring `id` (the fn id), `kind: "cron"`, `expectedCadence` (from the cron schedule it already knows), and a `livenessWindowMs` from the cadence (hourly→2h, daily→26h), and a **proposed `owner`** (inferred from the fn's file path / domain — e.g. `storefront-*` → growth, `meta-*` → growth, `ticket-*` → cs). Surfaces it `needs_approval` so the owner confirms the owner-function + window (or marks the loop **intentionally-unmonitored** — a registered exemption, so it stops re-surfacing).
- **Dedupe:** one open proposal per loop id (don't re-propose the same gap each audit) — mirror [[repair-agent-dedup]].
- **Two outcomes, both close the gap:** approve → the entry lands (the loop is monitored); "intentionally-unmonitored" → an exemption row so the audit no longer flags it. Either way the amber gap clears permanently.

## Verification
- Serve a new cron `createFunction` without a `MONITORED_LOOPS` entry → within one self-audit cycle a coverage-register proposal appears (`needs_approval`) with the inferred entry (id + cadence-derived window + proposed owner), citing the cron schedule. Approve → `registry.ts` gains the entry, the loop turns into a real monitored tile, the amber gap clears.
- Mark a loop **intentionally-unmonitored** → it's exempted (no entry) and **stops re-surfacing** in the audit.
- Re-run the audit with a gap already proposed → **no duplicate** proposal.
- Negative: a fn that already has a `MONITORED_LOOPS` entry → never flagged; the agent never silently edits `registry.ts` without the owner tap.

## Phase 1 — detect unregistered loop → propose the MONITORED_LOOPS entry ⏳
On a coverage self-audit gap, author + surface (deduped) the inferred `MONITORED_LOOPS` entry for one-tap Build, with an "intentionally-unmonitored" exemption path. Brain: [[control-tower-complete-coverage]] · [[../libraries/control-tower-self-audit]] · [[../libraries/control-tower]] (registry) · [[repair-agent]].
