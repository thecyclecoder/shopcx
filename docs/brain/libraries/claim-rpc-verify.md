# libraries/claim-rpc-verify

Verifies the live `public.claim_agent_job(text[])` RPC honors the cooldown contract that prevents serial-claim loops from wedging the box worker.

**File:** `src/lib/claim-rpc-verify.ts`

**Context:** The box worker's build/plan claim loop relies on the `public.claim_agent_job(text[])` RPC skipping a row whose `claimed_at` is a FUTURE "hold-until" instant — that's how a gate-held build backs off without churning the poll loop. If a hand-run migration or manual DDL drift removes the `(claimed_at is null or claimed_at <= now())` predicate, a released row with a future `claimed_at` is immediately re-claimable, and the poll loop wedges on that row forever without ever writing its own heartbeat. The Control Tower would correctly report the worker stale, but the operator would have no actionable signal ("worker is silent" instead of "claim RPC contract broken").

## Exports

### `ClaimCooldownVerification` — interface

```ts
interface ClaimCooldownVerification {
  ok: boolean;
  reason: string;
  probed: boolean;
  functionSource?: string;
}
```

- **`ok`** — true = live RPC honors the cooldown predicate (or we couldn't verify and are failing open). Consumed by the worker heartbeat gate.
- **`reason`** — Human-legible; safe to surface on the worker heartbeat's `detail` field.
- **`probed`** — true when the DB was probed AND the predicate check ran (ok reflects the live contract). False on pool-unavailable or query errors (fail-open).
- **`functionSource`** — Excerpt of the live function body when the predicate is missing — for operator diagnosis.

### `checkClaimAgentJobCooldownPredicate` — function

```ts
function checkClaimAgentJobCooldownPredicate(functionSource: string | null | undefined): ClaimCooldownVerification
```

**Pure predicate** — checks a `pg_get_functiondef` string for the cooldown clause `(claimed_at is null or claimed_at <= now())`. Separated from the async wrapper so a unit test can pin the exact grammar without a live DB. Returns the verdict struct. Test: `claim-rpc-verify.test.ts`.

### `verifyClaimAgentJobCooldown` — function

```ts
async function verifyClaimAgentJobCooldown(): Promise<ClaimCooldownVerification>
```

Reads the live `claim_agent_job(text[])` function body via `pg_get_functiondef` and checks for the cooldown predicate. **Fails open on pool-unavailable / query error** so a transient pool blip never falsely halts the box — the next tick re-checks. Called from [[../recipes/build-box-setup|builder-worker]] `ensureClaimAgentJobCooldownVerified` (below) before the build/plan claim loop each poll pass (throttled with a 10-minute TTL).

## Worker integration — `ensureClaimAgentJobCooldownVerified` ([[../recipes/build-box-setup|builder-worker]])

The box worker wraps this verifier in a TTL'd cache. The build/plan claim loop asks `ensureClaimAgentJobCooldownVerified()` each pass; the helper re-probes only after `CLAIM_COOLDOWN_VERIFY_INTERVAL_MS` (10 minutes) has elapsed. On a failed probe, the poll loop **skips the build/plan claim block entirely for that tick** (non-build lanes keep claiming) and the `writeHeartbeat` call below escalates the box tile to `needs_attention` with the verifier's reason — the operator sees the exact predicate-missing signal instead of a silent stale-worker mystery.

Verdict cache fields: `cachedClaimCooldownVerdict`, `lastClaimCooldownVerifyAt`.

## Gotchas

**The predicate lives in multiple migrations.** The regex pattern `COOLDOWN_PREDICATE_RX` matches `(claimed_at is null or claimed_at <= now())` in any whitespace/case. The SQL appears in:
- `supabase/migrations/20260727170000_durable_vale_review_passed_and_claim_cooldown.sql` (original introduction)
- `supabase/migrations/20261014000000_kill_switch_enforce_claim.sql` (kill-switch rewrite, predicate preserved)

A hand-run DDL change that modifies the function without the predicate will be caught by the next poll tick when `pg_get_functiondef` reads the live definition.

**Fail-open on pool errors.** If the shared pg pool has no credentials or the `pg_get_functiondef` call errors, the verifier returns `ok:true` with a "cannot verify" reason. Failing CLOSED on a pool blip would strand every build behind a phantom needs_attention. The verifier is defensive; a transient pool failure is not actionable proof that the predicate is missing.

---

[[../README]] · [[builder-worker|builder-worker (worker integration)]] · [[../recipes/build-box-setup|build-box-setup (full worker lifecycle)]]
