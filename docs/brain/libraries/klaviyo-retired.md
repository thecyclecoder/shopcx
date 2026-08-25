# libraries/klaviyo-retired

The ONE chokepoint that guarantees no code path reaches `a.klaviyo.com`. See [[../integrations/klaviyo]].

**File:** `src/lib/klaviyo-retired.ts`

## Exports

### `KLAVIYO_RETIRED` — const

```ts
const KLAVIYO_RETIRED = true
```

Master switch. `true` forever — a flip back would mean resuming traffic to a vendor we have no contract with.

### `KLAVIYO_RETIRED_AT` — const

```ts
const KLAVIYO_RETIRED_AT = "2026-08-25"
```

### `KLAVIYO_RETIRED_RESULT` — const

```ts
const KLAVIYO_RETIRED_RESULT: KlaviyoRetiredResult
```

The canonical no-op return for a retired Klaviyo Inngest handler. Inngest records it as the run output, so a human reading run history sees *why* nothing happened.

### `KlaviyoRetiredResult` — type

## Enforcement — two levels, belt and braces

1. **Credentials.** `getKlaviyoCredentials` ([[klaviyo]]) returns `null` when retired, regardless of what's stored on the workspace row — so every client function needing a key is dead even if someone re-enters one in Settings → Integrations.
2. **Handlers.** Each Klaviyo Inngest function early-returns `KLAVIYO_RETIRED_RESULT` as its first body statement. The two cron nodes emit their heartbeat *first*, so Control Tower renders "retired" instead of RED "no beats" against their `MONITORED_LOOPS` rows.

## The rail

`scripts/_check-no-klaviyo-calls.ts` (wired into `predeploy`) fails the build if any `src/**` file names `a.klaviyo.com` without importing this module. No allow-list — a genuinely new Klaviyo integration needs a contract before it needs this check changed.

## Callers

- `src/lib/klaviyo.ts`
- `src/lib/klaviyo-lead.ts`
- `src/lib/inngest/sync-reviews.ts`
- `src/lib/inngest/klaviyo-engagement-sync.ts`
- `src/lib/inngest/klaviyo-engagement-backfill.ts`
- `src/lib/inngest/klaviyo-events-import.ts`
- `src/lib/inngest/klaviyo-sms-import.ts`
- `src/lib/inngest/klaviyo-attribution-compute.ts`
- `src/app/api/workspaces/[id]/sync-reviews/route.ts`

## Gotchas

- This is Phase A — a **guard**, not a deletion. Phase B removes the guarded modules entirely, at which point the check scans clean with nothing to allow.

---

[[../README]] · [[../integrations/klaviyo]] · [[klaviyo]] · [[../../CLAUDE]]
