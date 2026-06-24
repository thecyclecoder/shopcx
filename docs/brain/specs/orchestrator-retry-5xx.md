# Orchestrator: retry Anthropic 5xx, not just 529 ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/sonnet-orchestrator-v2.ts::real-bug`
**Repair-signature:** `vercel:caec228f9136b469`

Harden the Sonnet/Opus orchestrator API loop so a transient Anthropic 5xx (500 internal_server_error / 502 / 503) is retried once instead of immediately degrading the ticket to a generic escalation, closing the gap where only 529 is currently retried.

## Problem (from Control Tower signature `vercel:caec228f9136b469`)
A single Anthropic 500 (api_error "Internal server error", request_id req_011CcLLf5rFgopX8yEmBrXzX) surfaced as ERR /api/inngest: 'Orchestrator (opus) API error: 500'. In runSonnetOrchestrator the !res.ok branch at src/lib/sonnet-orchestrator-v2.ts:1704-1738 only retries res.status===529; any 500/502/503 falls straight through to fallbackWithCancelRoute (line 1737), giving the customer a generic 'someone will email you' instead of a real AI decision, despite the 500 being transient and retryable. The same omission exists on the force-decision path (line 1880-1884).

**Likely target:** `src/lib/sonnet-orchestrator-v2.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

**What landed.** The **main `!res.ok` round-loop branch** (`src/lib/sonnet-orchestrator-v2.ts:1745-1748`) already retried *all* transient statuses — `isRetryableAnthropicStatus(status)` (429/5xx incl. 500/502/503/529) throws `AnthropicDependencyError` so the Inngest run retries across the outage, only terminal 4xx degrades to `fallbackWithCancelRoute`. That part was closed by [[agent-outage-resilience]] Phase 1 and covers the originating 500 signature directly.

The remaining gap this spec closes is the **max-rounds force-decision call** (`:1885-1907`), which still swallowed a transient 5xx/network throw into the generic fallback. It now applies the identical rule: a retryable `forceRes.status` throws `AnthropicDependencyError`, and the inner `catch` re-throws any `isRetryableThrownError` (incl. raw network failures) so the outer catch propagates it and Inngest retries; a terminal 4xx / parse failure still degrades gracefully. Brain page [[../libraries/sonnet-orchestrator-v2]] updated to note both call sites are covered.

## Verification
- In `src/lib/sonnet-orchestrator-v2.ts`, confirm the main round-loop `!res.ok` branch throws `AnthropicDependencyError` when `isRetryableAnthropicStatus(res.status)` (covers the originating 500) → expect throw, not `fallbackWithCancelRoute`, for a 500/502/503.
- In the same file's max-rounds **force-decision** branch (`forceRes` not ok), confirm a retryable status (e.g. 503) now throws `AnthropicDependencyError` and a raw network throw is re-thrown via `isRetryableThrownError` → expect the Inngest run to retry, not degrade to escalation; a terminal 4xx still returns `fallbackWithCancelRoute`.
- Re-trigger the originating condition (signature `vercel:caec228f9136b469`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:caec228f9136b469` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
