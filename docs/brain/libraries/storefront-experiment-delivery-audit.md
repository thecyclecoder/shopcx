# libraries/storefront-experiment-delivery-audit

Audit ground-truth that storefront experiments are actually being served to real shoppers. The **audit invariant** (never trust a tool's self-report): a `status='running'` [[../tables/storefront_experiments]] row must be verifiable with ≥1 [[../tables/storefront_sessions]] `experiment_assignments` write + ≥1 `experiment_exposure` pixel event in the last N hours. Zero delivery flips a derived flag the Director brief surfaces, and the [[../inngest/storefront-experiments]] refresh holds the experiment pending Director review. Foundation that UN-BLOCKS the [[../specs/adopt-storefront-optimizer]] flow; supports the goal's success metric by making the performance→creative loop accurate.

**File:** `src/lib/storefront/experiment-delivery-audit.ts` · Consumed by [[../inngest/storefront-experiments]] (Phase 2 standing sweep). See spec `docs/brain/specs/growth-storefront-experiment-delivery-verification.md`.

## Exports

### `auditExperimentDelivery(admin, { workspaceId, sinceMs = 24h })`  → `[{ experiment_id, lander_type, sessions_count, exposures_count, delivered, flags[] }]`
Counts active [[../tables/storefront_experiments]] rows (`status='running'` or `status='promoted'`), auditing each against its delivery signals:
- **(a)** Rows in [[../tables/storefront_sessions]] whose `experiment_assignments` jsonb contains the experiment id (excluding `is_internal=true` / `is_bot=true`)
- **(b)** `experiment_exposure` events for the (experiment, variant) keys in the same window

Returns one result per running/promoted experiment. Logic:
- **Zero on both + experiment older than `MIN_AUDIT_AGE_HOURS` (default 6)** → `delivered=false, flags:['failed_to_deliver']` (the audit reached a decision; the experiment has had time to accrue traffic but showed none).
- **≥1 of each** → `delivered=true` (verified serving).
- **Younger than the floor** → `delivered=null, excluded from results` (avoids flagging a freshly-promoted row with no traffic yet).

Idempotent per experiment per pass. Used by [[../inngest/storefront-experiments]] as a pre-bandit guardrail.

### `loadUndeliveredExperiments(admin, workspaceId)` → `[{ experiment_id, lander_type, hours_since_start, last_attempted_variant }]`
Reads the Director brief's undelivered experiment index: every `running`/`promoted` [[../tables/storefront_experiments]] row carrying `last_decision.delivery_flag='failed_to_deliver'`, with age + last variant. Null if no failed experiments. Used by the control tower UI to surface blocked experiments to the Growth director.

## Gotchas
- **No fallback** — zero delivery is a hard block, not a "wait and retry" signal. The bandit refresh runs after the audit but refuses to promote/kill any experiment carrying the flag.
- **Idempotent per pass** — each refresh pass writes one `director_activity` row per `failed_to_deliver` experiment via a per-experiment `step.run` so Inngest retries only replay incomplete writes.
- **Internal traffic excluded** — the audit reads `storefront_sessions.is_internal` + `is_bot` and skips those rows, so staff testing doesn't pollute the delivery signal.
