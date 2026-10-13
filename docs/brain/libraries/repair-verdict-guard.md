# libraries/repair-verdict-guard

Shared pure and semi-pure helpers for the repair lane's **transient** verdict disposition. Extracted from inline regexes and DB reads scattered across [[repair-agent]] + `scripts/builder-worker.ts` into testable, reusable guards.

**File:** `src/lib/repair-verdict-guard.ts` · **Tests:** `src/lib/repair-verdict-guard.test.ts`

## Why this module exists

The repair lane's core **pending-verification gate** (see [[repair-agent]] § Validation discipline) must be embedded in CODE, not just the LLM prompt — a slipped verdict cannot silently close a loop on an unverified fix. This module factors out three critical tests so they can be unit-tested, imported anywhere, and depended on as the gate-keeper between a `"transient"` reason and a parkable one.

## The three tests

### 1. `citesUnverifiedFix(reason: string): boolean` — the unverified-fix gate

Returns true when a `"transient"` reason references a fix that has NOT yet been verified in production. On a match, the repair lane PARKS the job (`needs_attention`, "pending verification — unverified fix cited") instead of resolving + completing.

**Triggers (unchanged from the original inline regex, except the narrowed in-flight clause):**
- `pending deploy`, `pending verification`
- `already-fixed`, `resolved-by`, `auto-queued`, `queued build`
- a fix-attached `in-flight` — `fix in-flight`, or `in-flight build|spec|PR|deploy|fix` (a BARE `in-flight`, as in "reaps in-flight Inngest cron ticks", does NOT match)
- a `[[spec-slug]]` wiki link (an authored fix spec)

**The narrowed in-flight clause — why it matters:** The original regex matched the bare word `in-flight` ANYWHERE. Deploy-storm diagnoses legitimately say things like "a deploy reaped in-flight Inngest runs" — a description of what happened to the CRON, not a citation of a pending fix. Those correct `transient` verdicts got mis-parked as "pending verification — unverified fix cited", escalated to the CEO inbox, and never cleared (the three Sep 18 deploy-storm parks: deploy-guardian-cron, meta-capi-dispatch-cron, amplifier-import-reconcile — 25 days as Park Backstop cards).

### 2. `beatsAreRecovered(beats: LoopBeat[], minOkBeats = 2): boolean` — pure recovery predicate

A pure function over `loop_heartbeats` rows that determines if a monitored loop has recovered since an anchor.

**Logic:** Recovered ⇔ there are at least `minOkBeats` healthy (`ok=true`) beats in the window AND no failed beat (`ok=false`) landed after the most-recent healthy beat — i.e., the loop is CURRENTLY green and has stayed green for enough beats to trust it, not mid-flap.

- An empty window (the loop never ran since the alert) is NOT recovered — absence of beats is not evidence of health.
- Beats may be in any order; this function sorts a copy by `ran_at` internally.
- Factored out of the DB call so it can be unit-tested against fixtures with no database.

### 3. `isLoopRecoveredSince(admin, loopId, sinceIso, minOkBeats = 2): Promise<boolean>` — DB recovery check

The machine-checkable recovery signal for a parked loop-alert repair. Reads `loop_heartbeats` for `loop_id = loopId` with `ran_at > sinceIso` and applies `beatsAreRecovered` to the result.

**Fail-safe:** On a DB error (or no rows) it returns `false` — a repair stays parked rather than closing on a read that failed.

**Call sites:**
1. In `runRepairJob` (scripts/builder-worker.ts) — when `source='loop-alert'` and the reason trips `citesUnverifiedFix`, it checks recovery FIRST. If recovered, it resolves + `completed` with "transient → verified recovered via heartbeats" instead of parking.
2. In the needs-attention sweep ([[needs-attention-route]]) — `autoVerifyParkedLoopRepair` auto-closes a parked loop repair if the loop has since recovered, draining stale parks that no human will ever review.

### 4. `loopIdFromSignature(signature: string | null | undefined): string | null` — helper

Strips the `loop:` prefix off a repair signature (`loop:<id>` → `<id>`); returns null if not a loop signature. Used in both `autoVerifyParkedLoopRepair` and repair brief-loading.

## LoopBeat interface

```typescript
interface LoopBeat {
  ran_at: string;  // ISO timestamp
  ok: boolean;     // health flag
}
```

Pared down from the full `loop_heartbeats` row to the fields the recovery predicate needs.

## Exports

- `citesUnverifiedFix(reason: string): boolean`
- `LoopBeat` — interface for a single heartbeat row
- `beatsAreRecovered(beats: LoopBeat[], minOkBeats = 2): boolean`
- `isLoopRecoveredSince(admin: Admin, loopId: string, sinceIso: string, minOkBeats = 2): Promise<boolean>`
- `loopIdFromSignature(signature: string | null | undefined): string | null`

## Callers

- `scripts/builder-worker.ts` (`runRepairJob`, transient branch) — calls `citesUnverifiedFix` + `isLoopRecoveredSince`
- `src/lib/agents/needs-attention-route.ts` (`autoVerifyParkedLoopRepair`) — calls `isLoopRecoveredSince` + `loopIdFromSignature`
- Unit tests — `src/lib/repair-verdict-guard.test.ts`

## Related

[[repair-agent]] · [[needs-attention-route]] · [[../tables/loop_heartbeats]] · [[../tables/loop_alerts]] · [[../tables/error_events]] · [[../specs/repair-transient-park-verifies-itself]]
