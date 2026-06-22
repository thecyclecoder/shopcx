# inngest/inngest-failure-capture

Captures errored Inngest runs into the Control Tower **error feed** ([[../specs/error-feed-monitoring]] Phase 1). Registers on the native `inngest/function.failed` event — which Inngest fires **once** a function exhausts its retries — so a function dying after its last retry becomes a visible, paged incident instead of a lucky log dig. Real-time, no polling, no setup.

**File:** `src/lib/inngest/inngest-failure-capture.ts` · records via [[../libraries/control-tower]] (`src/lib/control-tower/error-feed.ts` → `recordError`)

## Functions

### `inngest-failure-capture`
- **Trigger:** event `inngest/function.failed` (Inngest's built-in, fired after final retry)
- **Retries:** `retries: 1`
- **What it does:** reads `data.function_id`, `data.run_id`, `data.error`, `data.event` from the failure event and calls `recordError({ source: "inngest", keyParts: [function_id, errName, errMessage], … })`. Grouped by **function id + error class** so a flapping function is **one** [[../tables/error_events]] incident (count bumped), and the owners are paged once per incident via [[../libraries/notify-ops-alert]] (rate-limited; since this fires only after the final retry, never per-retry).
- **Self-loop guard:** if `function_id === 'inngest-failure-capture'` it returns `{ skipped: "self" }` — capturing its own failure would fan out infinitely.
- **Returns** `{ captured: function_id, run_id }` (or `{ skipped }`).

## Downstream events sent

_None._ Side effects: a [[../tables/error_events]] write + (on a new signature / past the page cooldown) a Slack DM.

## Tables written

- [[../tables/error_events]] (via `recordError`, `source='inngest'`)

## Tables read (not written)

- `workspace_members` (to find Slack-connected owners/admins to page — inside `recordError`)

## Gotchas

- **Fires after retries are exhausted**, not on each attempt — so one page per real incident, matching the spec's "paged once (not per-retry)".
- **Must be registered in `src/app/api/inngest/route.ts`** (it is) — an unregistered handler never sees the event.

## Related

[[../specs/error-feed-monitoring]] · [[../libraries/control-tower]] · [[../tables/error_events]] · [[../integrations/vercel-log-drain]] · [[control-tower-monitor]] · [[../dashboard/control-tower]]
