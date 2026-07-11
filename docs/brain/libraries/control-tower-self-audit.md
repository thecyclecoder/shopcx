# libraries/control-tower-self-audit

The Control Tower **detection layer** ([[../specs/control-tower-complete-coverage]] Phase 2) — the watchdog auditing its own coverage + a reliable deploy-time Inngest re-sync, so a coverage gap surfaces *automatically* instead of waiting for someone to notice. Enforces the [[../operational-rules]] "register-or-it's-incomplete" rule by **detecting** violations, not trusting authors.

**Files:** `src/lib/inngest/registered-functions.ts` · `src/lib/control-tower/self-audit.ts` · `src/lib/inngest/sync.ts`

## `registered-functions.ts` — the served-function list (single source of truth)

`registeredInngestFunctions: InngestFunction[]` — the exact array passed to `serve()` in `src/app/api/inngest/route.ts`. Extracted out of the route into a plain module so the self-audit can **enumerate it at runtime** (the route imports it and spreads it verbatim). Add a new Inngest function HERE and the serve route + the self-audit both pick it up. This is the authoritative "what's in code" set both diffs run against.

## `self-audit.ts` — two read-only coverage diffs

- `enumerateCodeCrons()` → `CodeCron[] { id, crons[] }` — every CRON function in the serve route (a `createFunction` whose `opts.triggers` includes a `cron`). Reads each function's `opts.id` / `id()` and `opts.triggers` directly off the runtime object (no source parsing — works in the bundled serverless build).
- `auditCronCoverage()` → `UnregisteredLoop[] { id, cadence }` — **CODE ↔ REGISTRY** diff: cron functions in code with **no `MONITORED_LOOPS` cron tile** and not on the `INTENTIONALLY_UNMONITORED_CRONS` allow-list. Pure + synchronous. These become amber **"unregistered loop: X"** tiles, and each one now also triggers the [[coverage-register-agent]] ([[../specs/coverage-auto-register-agent]] P1): `runControlTowerMonitor` calls `enqueueCoverageRegisterJob` per unregistered loop, which authors the inferred `MONITORED_LOOPS` entry + surfaces it for one-tap owner Build (deduped, one open proposal per loop id) — detect→propose-fix, mirroring the repair agent. (Validated: 49 cron functions in code; the registry's 9 cron entries leave 40 unregistered until [[../specs/control-tower-complete-coverage]] Phase 1 registers them all → 0.)
- `diffInngestRegistered()` → `InngestRegistrationDiff { status, missing[] }` — **CODE ↔ INNGEST-REGISTERED** diff: serve-route fn ids that Inngest Cloud hasn't registered (the deploy-didn't-re-sync gap — the exact `control-tower-monitor` "awaiting first run for days" failure, from the registration side rather than the heartbeat side). **Best-effort**: probes the Inngest REST API (`GET ${INNGEST_API_BASE_URL||https://api.inngest.com}/v1/apps/shopcx/functions`, `Authorization: Bearer ${INNGEST_SIGNING_KEY}`) — a **flat array of the ~136 registered functions, each keyed by an app-prefixed `id`** (`shopcx-sync-shopify`, **no `slug` field**) — and strips the `shopcx-` app-id prefix off each returned `id`. Returns `status:'unverified'` (no diff, never a false alarm) on a missing key / non-2xx / unexpected shape — mirrors the [[control-tower]] supabase-log-poll "no-token → no-op" pattern. (The bare `/v1/apps` endpoint 404s — fixed in `inngest-registered-diff-endpoint-fix`.) The never-fired cron check (`evalCron`) covers the same gap operationally from the heartbeat side regardless.
- `buildCoverageAudit()` → `CoverageAudit { unregistered, inngestRegistration }` — runs both; folded into the [[control-tower]] snapshot (`selfAudit`), its findings added to the honest amber header count, logged in `runControlTowerMonitor` (greppable), and rendered as the dashboard "Coverage self-audit" section. Amber, **not** a page (the never-fired RED is the paging signal).

The "AI entry points" the spec mentions are the hand-registered inline agents (`INLINE_AGENT_IDS`, already `MONITORED_LOOPS` rows from [[../specs/control-tower-agent-coverage]]) — there's no runtime `createFunction` set to enumerate them from, so they're not part of the cron diff.

## `sync.ts` — deploy-time Inngest re-sync

`syncInngestRegistration(serveUrl?)` → `SyncResult { ok, status, url, detail }` — **PUTs the serve endpoint** (`INNGEST_SERVE_URL` || `https://shopcx.ai/api/inngest`), Inngest's documented "manual sync": the SDK re-introspects `registered-functions.ts` and registers any newly-added `createFunction`. Best-effort, never throws. Driven by:
- The box build worker on startup (`scripts/builder-worker.ts` `main()`, fire-and-forget) — the worker restarts right after it self-updates to a freshly-deployed SHA, so this is the **deploy-time trigger**: a new cron registers automatically instead of silently never firing.
- `scripts/sync-inngest.ts` — manual / deploy-hook entry point (`npx tsx scripts/sync-inngest.ts [serveUrl]`).

## Gotchas

- **`fn.opts.id` is the raw id** (`control-tower-monitor`); Inngest Cloud knows it as `<appId>-<id>` (`shopcx-control-tower-monitor`) — `diffInngestRegistered` strips the `shopcx-` prefix before comparing. Heartbeat `loop_id`s + `MONITORED_LOOPS` ids use the raw id, so the code↔registry diff needs no prefix handling.
- **Self-audit never pages** — coverage gaps are amber (warnings). The paging signals are the loop RED checks in [[control-tower]] (`evalCron` never-fired included).
- **`diffInngestRegistered` fails safe** — `unverified` whenever the Inngest API can't be reached/parsed, so a missing `INNGEST_SIGNING_KEY` (local/preview) or an API shape change never produces a false "missing".

## Callers

[[control-tower]] (`buildControlTowerSnapshot` → `buildCoverageAudit`; `runControlTowerMonitor` logs findings) · `src/app/api/inngest/route.ts` (`registeredInngestFunctions`) · `scripts/builder-worker.ts` + `scripts/sync-inngest.ts` (`syncInngestRegistration`) · [[../dashboard/control-tower]] (the "Coverage self-audit" section).

## Related

[[control-tower]] · [[control-tower-node-registry]] — the canonical org tree fusing MONITORED_LOOPS + personas + the builder-worker kind universe; complements this page's CODE↔REGISTRY diff by catching the OTHER dimension of drift (an owner mapping missing from the registry, surfaced by `scripts/_check-node-registry-drift.ts`) · [[coverage-register-agent]] · [[../specs/control-tower-complete-coverage]] · [[../specs/coverage-auto-register-agent]] · [[../specs/control-tower-canonical-node-registry]] · [[../specs/control-tower]] · [[../inngest/control-tower-monitor]] · [[../dashboard/control-tower]] · [[../operational-rules]]
