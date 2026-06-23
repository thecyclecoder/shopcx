# Orchestrator: retry Anthropic 5xx, not just 529 ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/sonnet-orchestrator-v2.ts::real-bug`
**Repair-signature:** `vercel:caec228f9136b469`

Harden the Sonnet/Opus orchestrator API loop so a transient Anthropic 5xx (500 internal_server_error / 502 / 503) is retried once instead of immediately degrading the ticket to a generic escalation, closing the gap where only 529 is currently retried.

## Problem (from Control Tower signature `vercel:caec228f9136b469`)
A single Anthropic 500 (api_error "Internal server error", request_id req_011CcLLf5rFgopX8yEmBrXzX) surfaced as ERR /api/inngest: 'Orchestrator (opus) API error: 500'. In runSonnetOrchestrator the !res.ok branch at src/lib/sonnet-orchestrator-v2.ts:1704-1738 only retries res.status===529; any 500/502/503 falls straight through to fallbackWithCancelRoute (line 1737), giving the customer a generic 'someone will email you' instead of a real AI decision, despite the 500 being transient and retryable. The same omission exists on the force-decision path (line 1880-1884).

**Likely target:** `src/lib/sonnet-orchestrator-v2.ts`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `vercel:caec228f9136b469`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:caec228f9136b469` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
