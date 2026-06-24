# Don't open a Control Tower incident when the orchestrator throws a retryable Anthropic error for Inngest to retry ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] + [[../specs/chat-fallback-absorbed-anthropic-overload-noise]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/sonnet-orchestrator-v2.ts::monitor-false-positive`
**Repair-signature:** `vercel:caec228f9136b469`

Re-level the orchestrator's API-error diagnostic so a transient, retryable Anthropic failure (429/5xx incl. 500/529) that is handled by throwing AnthropicDependencyError — the designed Inngest-retry self-heal — no longer mints a false Control Tower 'vercel' incident. The orchestrator already self-heals on these statuses; only a non-retryable terminal degrade (or genuine Inngest retry exhaustion) should page. Monitor-only: no behavior change to the retry/throw logic itself.

## Problem (from Control Tower signature `vercel:caec228f9136b469`)
sonnet-orchestrator-v2.ts:1737 emits console.error('Orchestrator (opus) API error: 500 …') unconditionally, before the branch at line 1745 where a retryable status (isRetryableAnthropicStatus, status>=500) THROWS AnthropicDependencyError so the Inngest run retries with outage-spanning backoff (agent-outage-resilience). The Vercel log drain isError() (vercel-logs/route.ts:73, level==='error') scrapes that line and recordError opens a 'vercel' incident (signature vercel:caec228f9136b469, event 82c606dc, count=1, status 0, path /api/inngest) even though the loop self-heals on retry. The force-decision path at lines 1893/1900 has the identical pattern. Fix: when isRetryableAnthropicStatus(res.status) is true, log via console.warn (the throw + Inngest retry record/handle it); reserve console.error for the non-retryable terminal fallbackWithCancelRoute path. Add a brief code comment referencing the chat-fallback sibling spec.

**Likely target:** `src/lib/sonnet-orchestrator-v2.ts`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `vercel:caec228f9136b469`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:caec228f9136b469` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
