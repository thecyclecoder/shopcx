# libraries/crowned-winners

Typed read+write chokepoint over [[../tables/media_buyer_crowned_winners]] — the durable ledger of Media-Buyer-crowned test adsets. The single allowed entry point for reading or writing a crown marker (CLAUDE.md § "Raw .from(...) STOP" — a wrong column name against the table silently reads as empty otherwise).

**File:** `src/lib/media-buyer/crowned-winners.ts` · Authored by [[../specs/media-buyer-persist-crowned-winners-and-guard-reactivation]] Phase 1.

**Callers:**
- Bianca's Media Buyer pass — `src/lib/media-buyer/agent.ts` `runMediaBuyerLoop` calls `recordCrownedWinner` once per detected winner with a resolved parent adset.
- Recovered-CPA reactivation (Phase 2) — [[meta-cpa-signal]] `detectMetaCpaReactivations` calls `listCrownedWinnerAdsetIds` and excludes those adset ids from the candidate set before the CPP recovery loop.
- Future graduate / re-test / replenish flows (contract) — MUST consult `listCrownedWinnerAdsetIds` before re-testing a creative or unpausing an adset.
- Dahlia's replenish (explore/exploit split, [[../specs/media-buyer-explore-exploit-split-on-crown]] Phase 2) — reads `listActiveWinnersForProduct` to allocate exploit slots best-CAC-first, calls `incrementExploitSpawned` per spawn, `recordExploitHit` on a `promising|crown` verdict for an exploit-origin test, and (as an escape hatch) `markExploitExhausted` on an operator override.

**Distinct from** [[cold-scaler-cohort]] — that SDK reads the SCALER-rail CAMPAIGN configuration (does a scaler exist for this tuple, what's the ceiling); this SDK reads/writes the per-adset CROWN LEDGER (which specific test adset earned the scaler slot).

## Exports

### `EXPLOIT_EXHAUST_STRIKES` — const

```ts
export const EXPLOIT_EXHAUST_STRIKES = 4;
```

Consecutive dud exploit clones (spawned since the last hit) that mark a crowned winner exploit-exhausted. `incrementExploitSpawned` reads this constant; a hit clears both the strike counter and the exhausted flag. A NEW crown (a different `test_meta_adset_id` ⇒ its own row) re-arms exploit fresh with its own counters.

### `MediaBuyerCrownedWinner` — interface

TS shape of a [[../tables/media_buyer_crowned_winners]] row (snake → camel).

```ts
interface MediaBuyerCrownedWinner {
  id: string;
  workspaceId: string;
  metaAdAccountId: string | null;
  productId: string | null;
  testMetaAdsetId: string;
  winningMetaAdId: string | null;
  crownedAt: string;
  graduatedAt: string | null;
  scalerMetaCampaignId: string | null;
  scalerMetaAdsetId: string | null;
  exploitSpawned: number;
  exploitHits: number;
  exploitExhausted: boolean;
  exploitExhaustedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### `recordCrownedWinner` — function

```ts
async function recordCrownedWinner(
  admin: Admin,
  args: {
    workspaceId: string;
    metaAdAccountId?: string | null;
    productId?: string | null;
    testMetaAdsetId: string;
    winningMetaAdId?: string | null;
  },
): Promise<void>
```

Idempotent upsert on `(workspace_id, test_meta_adset_id)` with `ignoreDuplicates: true`. First call captures the crown fact; every subsequent call is a no-op — `graduated_at` / `scaler_meta_campaign_id` / `scaler_meta_adset_id` are NEVER clobbered by a Bianca replay. Those columns are set by the (future) graduate-crowned-winners flow; a replay resetting them would be a correctness bug.

Called from `src/lib/media-buyer/agent.ts` `runMediaBuyerLoop` right after `detectWinners` and `metaAdIdToAdsetId` resolve — one call per winner with a resolved parent adset. Best-effort at the call site: the marker write is wrapped in try/catch so a Supabase hiccup never fails the whole Media Buyer pass (the next pass will retry — idempotent).

### `listCrownedWinnerAdsetIds` — function

```ts
async function listCrownedWinnerAdsetIds(
  admin: Admin,
  args: { workspaceId: string; metaAdAccountId?: string | null },
): Promise<string[]>
```

Returns bare Meta adset ids (`test_meta_adset_id` column) of every crowned winner in the workspace, optionally narrowed to one Meta ad account. The Phase-2 reactivation guard consumes this: any candidate adset in the returned list is REMOVED from the reactivation candidate set before the CPP recovery loop.

Empty array when the workspace has no crowned winners yet (the ships-empty default).

### `getCrownedWinnerByTestAdset` — function

```ts
async function getCrownedWinnerByTestAdset(
  admin: Admin,
  args: { workspaceId: string; testMetaAdsetId: string },
): Promise<MediaBuyerCrownedWinner | null>
```

The readback the (future) graduate flow uses to stamp `graduated_at` + `scaler_meta_*` onto the SAME row it earlier marked crowned. Returns `null` when no row exists.

### `incrementExploitSpawned` — function

```ts
async function incrementExploitSpawned(
  admin: Admin,
  args: { workspaceId: string; testMetaAdsetId: string; by: number },
): Promise<void>
```

Bump the source winner's strike counter (exploit variants spawned SINCE the last hit) by `by`. When the resulting counter reaches `EXPLOIT_EXHAUST_STRIKES=4` AND lifetime `exploit_hits = 0` (never hit), the fn also flips `exploit_exhausted=true` and stamps `exploit_exhausted_at = now()` so `listActiveWinnersForProduct` drops the row on the very next Phase-2 pass.

Called from Dahlia's replenish path (Phase 2) once per allocated exploit slot against a source winner. `by` is the number of exploit variants spawned in THIS pass against that winner (1 or 2 — Phase 2 allocates round-robin best-CAC-first, so one pass can bump the same winner by 2). A non-positive `by` is a no-op; a missing marker row is a no-op (the SDK never inserts an implicit row).

### `recordExploitHit` — function

```ts
async function recordExploitHit(
  admin: Admin,
  args: { workspaceId: string; testMetaAdsetId: string },
): Promise<void>
```

Credit an exploit hit — an exploit-origin variant reached `promising` or `crown` in [[../tables/media_buyer_test_cohorts]] verdict-space. Bumps `exploit_hits`, RESETS `exploit_spawned` to 0 (strikes accumulate ONLY between hits), and clears `exploit_exhausted` + `exploit_exhausted_at` so the winner re-enters the exploit rotation on the next Phase-2 pass.

Called from Dahlia's Phase 3 verdict-attribution pass. A `dud`/`testing` outcome adds no reset — its spawn already counted a strike in Phase 2.

### `markExploitExhausted` — function

```ts
async function markExploitExhausted(
  admin: Admin,
  args: { workspaceId: string; testMetaAdsetId: string },
): Promise<void>
```

Explicitly mark a crowned winner exploit-exhausted (drops out of `listActiveWinnersForProduct`). Escape hatch for cases where the caller wants to hard-exhaust a winner without a spawn (operator override, or a follow-up spec's revert path). `incrementExploitSpawned` already flips the flag automatically when strikes ≥ `EXPLOIT_EXHAUST_STRIKES` with 0 hits, so most callers should not need this fn.

### `listActiveWinnersForProduct` — function

```ts
async function listActiveWinnersForProduct(
  admin: Admin,
  args: { workspaceId: string; metaAdAccountId: string; productId: string },
): Promise<MediaBuyerCrownedWinner[]>
```

Every non-exhausted crown-marker row for one product within one Meta ad account. Phase 2 sorts these best-CAC-first (via the testing-results/CPA read at the call site) and allocates the 2 exploit slots 1-per-winner round-robin (1 winner ⇒ both slots off it; 2+ winners ⇒ 1 each, top 2). Empty array ⇒ product has no active winners ⇒ `hasActiveWinner=false` ⇒ replenish falls back to `DEFAULT_TEST_COHORT_TARGET=4` explore / 0 exploit.

Reads via the `(workspace_id, meta_ad_account_id, product_id) WHERE exploit_exhausted = false` partial index — the exhausted rows never enter the returned set.

## Related

- [[../tables/media_buyer_crowned_winners]] — the backing table.
- [[meta-cpa-signal]] — Phase 2 wires `detectMetaCpaReactivations` to exclude crowned adsets via `listCrownedWinnerAdsetIds`.
- [[cold-scaler-cohort]] — sibling SDK for the SCALER-rail cohort (campaign configuration + ceiling).
- [[../specs/media-buyer-persist-crowned-winners-and-guard-reactivation]] — the introducing spec.
