# libraries/usage-snapshots

Per-account usage snapshots + hidden-limit discovery for the [[../archive.d/fleet-usage-cockpit]] Phase 1 — the write layer the box worker's standing pass calls to keep [[../tables/account_usage_snapshots]] fresh, plus the `MAX(tokens_at_wall)` discoverer that reads [[../tables/usage_wall_events]].

**File:** `src/lib/usage-snapshots.ts`

## Two-currency honesty (fleet-cost invariant)

The Max/Codex accounts carry TOKENS + rate-limit proximity, **never** a fabricated `$` (there is no per-token bill on a subscription or a ChatGPT plan). The API panel — [[ai_token_usage]] via [[ai-usage]] — is the only place `$` appears. See [[fleet-cost]] for the shared invariant.

## Exports

### `rollupBoxAccountUsage` — function

```ts
async function rollupBoxAccountUsage(opts: RollupBoxAccountUsageOpts): Promise<{ upserted: number }>
```

Rolls up per-account 5h + weekly token burn from [[../tables/agent_job_costs]] (summed per `account` over `now - 5h` / `now - 7d`) and UPSERTs ONE `source='box'` row per `(account, window)` into [[../tables/account_usage_snapshots]]. ALWAYS writes exactly one `'5h'` + one `'weekly'` row per Max account (`'Round Robin 1'..'Round Robin 4'`) + Codex — a healthy account with zero burn still gets a zeroed row so the Phase-3 cockpit can render it as "healthy, 0 tokens". Never throws (metering is best-effort — mirrors [[fleet-cost]] `recordAgentJobCost`).

`RollupBoxAccountUsageOpts`: `{ workspaceId, liveStates: AccountLiveState[], now? }`.
`AccountLiveState`: `{ account, runtime, capped, cappedUntil }` — one entry per Max account + one for Codex; mirrors the worker's in-memory `AccountState` / `codexState` (surfaced on [[../tables/worker_heartbeats]].`accounts`).

### `recordWallEvent` — function

```ts
async function recordWallEvent(p: RecordWallEventParams): Promise<boolean>
```

Best-effort insert of ONE detected wall event to [[../tables/usage_wall_events]]. Called from `scripts/builder-worker.ts` `recordUsageWallEventBestEffort` on `markAccountCapped` (Claude) / `markCodexCapped` (Codex) — stamped with the current window's token burn (via `currentWindowBurn`), the wall classification (`5h` vs `weekly`), and the parsed `wallResetAt`. Never throws.

`RecordWallEventParams`: `{ workspaceId, account, runtime, window, tokensAtWall, wallText?, wallResetAt? }`.

### `currentWindowBurn` — function

```ts
async function currentWindowBurn(workspaceId: string, account: string, window: UsageWindow, nowMs?: number): Promise<number>
```

Total tokens across `input + output + cache_creation + cache_read` for the given account over `now - 5h` or `now - 7d`, read directly from [[../tables/agent_job_costs]]. Never throws — a DB failure returns `0` so the wall-event write still lands. Helper for `recordWallEvent`.

### `discoverLimit` — function

```ts
async function discoverLimit(account: string, window: UsageWindow, adminOverride?: UsageSnapshotsAdmin): Promise<{ limit: number | null; wallCount: number }>
```

The running `MAX(tokens_at_wall)` across all sampled walls for `(account, window)` — Claude/Max only. Codex ⇒ `{ limit: null, wallCount: <count> }` (its real limit comes from `/status %`, not wall discovery). No walls sampled ⇒ `{ limit: null, wallCount: 0 }` — the Phase-3 cockpit renders `'learning…'` (never a fabricated %). Never throws — a DB failure returns `{ limit: null, wallCount: 0 }` so the cockpit gracefully degrades. `adminOverride` is a unit-test seam.

### `codexCostOverride` — function

```ts
function codexCostOverride(model: string | null | undefined): CodexCostOverride | null
```

**Pure mapping.** Returns `{ account: 'codex', configDir: null, apiBilled: false }` when the run's `model` starts with `"codex/"` (the id `runCodexSession` emits), else `null` (the caller keeps its Round-Robin-derived defaults). Used by `scripts/builder-worker.ts` `meterAgentJob` to route a Codex `turn.completed` into [[../tables/agent_job_costs]] under `account='codex'` + `apiBilled=false` — a ChatGPT plan has no per-token bill, so Codex carries token burn like a Max lane.

### Constants + types

- `MAX_ACCOUNT_LABELS` = `['Round Robin 1'..'Round Robin 4']` — must match the live [[../tables/agent_job_costs]].`account` values written by [[../recipes/build-box-setup]].
- `CODEX_ACCOUNT_LABEL` = `'codex'`.
- `UsageWindow` = `'5h' | 'weekly'`; `UsageRuntime` = `'claude' | 'codex'`.
- `UsageSnapshotsAdmin` — the minimal admin surface `discoverLimit` reads (unit-test seam).

## Callers

- **Writer:** `scripts/builder-worker.ts`:
  - `writeHeartbeat` → `runAccountUsageRollupBestEffort` → `rollupBoxAccountUsage` (per heartbeat tick).
  - `markAccountCapped` / `markCodexCapped` → `recordUsageWallEventBestEffort` → `currentWindowBurn` + `recordWallEvent` (on cap detection).
  - `meterAgentJob` → `codexCostOverride` — overlays account+configDir+apiBilled on a Codex turn.
- **Reader (Phase 3):** `GET /api/developer/usage` → `discoverLimit(account, window)` per Max card, and SUMs `source='box'` + `source='mac'` from [[../tables/account_usage_snapshots]].

## Gotchas

- **Never a `$`.** This module writes tokens + rate-limit proximity. `$` lives in [[ai-usage]] / [[ai_token_usage]] and is rendered on the cockpit's API panel, separately.
- **Best-effort writes.** A rollup / wall-event failure must never break the heartbeat or cap-handling — both callers wrap `.catch()` and swallow.
- **Codex `discoverLimit` returns null by design.** Codex's real limit lives in `/status %` (`limit_pct` in [[../tables/account_usage_snapshots]]); wall events are recorded for the wall COUNT (confidence) only.

## Related

[[../tables/account_usage_snapshots]] · [[../tables/usage_wall_events]] · [[../tables/agent_job_costs]] · [[../tables/worker_heartbeats]] · [[fleet-cost]] · [[ai-usage]] · [[developer-nav]] · [[../archive.d/fleet-usage-cockpit]] · [[../functions/platform]] · [[../recipes/build-box-setup]]
