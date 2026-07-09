# libraries/coverage-register-agent

The detection→propose-fix agent that closes Control Tower **coverage gaps** automatically ([[../specs/coverage-auto-register-agent]] Phase 1) — "the [[repair-agent]], but for the [[control-tower-self-audit|coverage self-audit]]." The self-audit *detects* an unregistered loop (a cron `createFunction` served in code with no `MONITORED_LOOPS` tile + not on the exemption list); this is the objective-owner loop above that proxy — it *authors* the inferred registry entry and *surfaces* it for one-tap owner Build.

**File:** `src/lib/coverage-register-agent.ts` · box runner: `scripts/builder-worker.ts` `runCoverageRegisterJob` · owner endpoint: `src/app/api/developer/control-tower/coverage-register/route.ts`.

## North star — surface-don't-auto-edit

Adding a monitored loop sets an **alerting contract**, so the agent NEVER silently edits `registry.ts`. It proposes the inferred entry; the **owner** confirms the owner-function + cadence/window (or marks the loop intentionally-unmonitored) before the change lands. Mirrors [[repair-agent]]'s surface-don't-auto-build guard — here the fix is fully *mechanical*, so there's no LLM diagnosis, just deterministic inference + an owner gate.

## Deterministic inference (no LLM)

Unlike the repair agent, the fix is mechanical — inferred at enqueue time in the deployed monitor:
- `inferCadence(cronExpr)` → `{ label, windowMs }` — human cadence label + a cadence-derived `livenessWindowMs` (cadence + grace, mirroring the registry conventions: hourly→2h, daily→26h, every-N-min→~4N min, weekly→8d).
- `inferOwner(loopId)` → `OwnerFunction` — `storefront-`/`meta-`/ads/capi → growth · `ticket-`/escalation/csat → cs · renewal/subscription/dunning/loyalty/journey/return → retention · scorecard/campaign → cmo · else platform.
- `inferLoopEntry(loopId, cadence)` → the full `InferredLoopEntry` (`id`, `kind:'cron'`, `owner`, `label`, `description`, `expectedCadence`, `livenessWindowMs`, and `registeredAt` for ≥daily crons so they claim the [[control-tower]] `registered_not_firing` newcron grace).
- `renderEntrySnippet(entry)` → the exact TS to paste into `MONITORED_LOOPS` (window in the `N * UNIT` house style). `buildRegisterSpecBody(entry)` / `buildExemptSpecBody(loopId, owner)` → the two single-phase fix-spec markdowns (register the entry · add the `INTENTIONALLY_UNMONITORED_CRONS` exemption), both baked into the job's `instructions`.

## Trigger — event-driven on the audit (NOT a cron)

`enqueueCoverageRegisterJob(admin, { loopId, cadence })` is called inline in [[control-tower]] `monitor.ts` `runControlTowerMonitor`, once per `selfAudit.unregistered` loop. Best-effort, never throws (it rides the monitor's act loop). It inserts a `coverage-register` [[../tables/agent_jobs]] job **directly in `needs_approval`** (no diagnosis run needed) with the inferred entry + both fix-spec bodies in `instructions` and a single `coverage_register` pending action.

**Dedup — one open proposal per loop id** (`spec_slug = coverage-register:<loopId>`): skipped if a coverage-register job for that loop is already *live* (`queued`…`queued_resume` ∪ `needs_attention`), OR if a non-dismissed one **completed within `COVERAGE_REGISTER_RECENT_WINDOW_MS` (24h)** — its fix is pending deploy, so don't re-propose while the audit still sees the gap. Mirrors [[repair-agent-dedup]] / the DB-Health re-propose guard.

## Owner action → box materializes the fix (`runCoverageRegisterJob`)

`POST /api/developer/control-tower/coverage-register` is owner-gated and takes `{ jobId, action }`:
- **`register`** → approve the action (`decision:'register'`) + flip the job to `queued_resume`. The box materializes `register_spec_body` to `docs/brain/specs/<register-loop-…>.md` on main + queues its `build` job (deduped by `hasActiveBuildForSlug` — ≤1 build/slug). The build makes the small `registry.ts` edit; on merge+deploy the amber gap clears and a real cron tile appears.
- **`exempt`** (intentionally-unmonitored) → `decision:'exempt'` + `queued_resume`; the box materializes the `INTENTIONALLY_UNMONITORED_CRONS` exemption spec + queues its build. After deploy the audit no longer flags the loop.
- **`dismiss`** → decline + complete directly (no box round-trip); the gap may re-surface on a later audit (the "not now" path).

Both register + exempt close the gap permanently. The build is queued ONLY on the owner tap (the North-star gate).

## Read surface

`getOpenCoverageRegistrations(admin, workspaceId)` → `CoverageRegisterItem[]` (READ-ONLY) — the open proposals (`needs_approval`) with the inferred owner/cadence + the register slug. Drives the Control Tower **"Coverage registration"** feed ([[../dashboard/control-tower]]), rendered just below the Coverage self-audit section.

## Hardened owner-classification + error-handling (rolled from coaching)

- **Owner classification is now explicit, never a silent guess** — `inferOwner` explicitly classifies research/creative/acquisition/lander/scout crons as `growth` (was falling through to the boilerplate `platform` default, mis-owning entries like `acquisition-research-cadence-cron`). If `inferOwner` cannot classify a loop id (does not match any domain regex), it returns `null`; `inferLoopEntry` then sets `description: "**REQUIRES OWNER CONFIRMATION** — inferOwner could not classify…"` with explicit instructions for the owner to set the true owner before merging, instead of a silent placeholder.
- **Spec authoring is re-verified** — `runCoverageRegisterJob` wraps `markNewSpecInReview` + build-enqueue in try/catch, then re-reads the row via `specs-table.getSpec(workspaceId, slug)` to confirm it was actually created. If `getSpec` returns null (author failure), the job parks `needs_attention` with a step-specific diagnosis, never equating "invoked the author helper" with "spec created".
- **All failures carry remediation paths** — any spec-authoring or build-enqueue failure includes `renderEntrySnippet(instructions.entry)` as a one-tap manual-paste remediation path (the exact TS to add to `MONITORED_LOOPS`), so an owner seeing `needs_attention` has an immediate fallback, never a bare one-word error or a MissingVerification escape as generic "no verdict". Diagnosis always states which step failed (markNewSpecInReview / build-enqueue / empty spec body) + the concrete error.

## Gotchas

- **No migration** — `coverage-register` is a free-text [[../tables/agent_jobs]] `kind` (like `repair` / `db_health`); the proposal parks in the existing `pending_actions` jsonb (`type:'coverage_register'`, `decision`, `spec_slug`). The box claims it only once the route flips it to `queued_resume` (claim_agent_job claims `queued`/`queued_resume`).
- **Inference is generous-but-safe** — the owner confirms before merge, so a coarse window (e.g. "multiple times hourly" → 90 min) is the right default, never a false red.
- **The proposal is authored in the deployed runtime, materialized on the box** — the monitor (Next runtime) builds the spec *bodies* (pure strings), but only the box can write them to main (gh API), so the actual spec commit + build enqueue happen in `runCoverageRegisterJob`, reusing `materializeDbHealthSpec` + `hasActiveBuildForSlug`.

## Callers

`src/lib/control-tower/monitor.ts` (`enqueueCoverageRegisterJob` in `runControlTowerMonitor`) · `scripts/builder-worker.ts` (`runCoverageRegisterJob`) · `src/app/api/developer/control-tower/route.ts` (`getOpenCoverageRegistrations`) · `src/app/api/developer/control-tower/coverage-register/route.ts` (Register/Exempt/Dismiss) · [[../dashboard/control-tower]].

## Related

[[../specs/coverage-auto-register-agent]] · [[control-tower-self-audit]] · [[control-tower]] (registry) · [[repair-agent]] · [[../specs/control-tower-complete-coverage]] · [[../tables/agent_jobs]] · [[../dashboard/control-tower]] · [[../operational-rules]]
