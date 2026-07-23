# libraries/crowned-winners

Typed read+write chokepoint over [[../tables/media_buyer_crowned_winners]] — the durable ledger of Media-Buyer-crowned test adsets. The single allowed entry point for reading or writing a crown marker (CLAUDE.md § "Raw .from(...) STOP" — a wrong column name against the table silently reads as empty otherwise).

**File:** `src/lib/media-buyer/crowned-winners.ts` · Authored by [[../specs/media-buyer-persist-crowned-winners-and-guard-reactivation]] Phase 1.

**Callers:**
- Bianca's Media Buyer pass — `src/lib/media-buyer/agent.ts` `runMediaBuyerLoop` calls `recordCrownedWinner` once per detected winner with a resolved parent adset.
- Recovered-CPA reactivation (Phase 2) — [[meta-cpa-signal]] `detectMetaCpaReactivations` calls `listCrownedWinnerAdsetIds` and excludes those adset ids from the candidate set before the CPP recovery loop.
- Future graduate / re-test / replenish flows (contract) — MUST consult `listCrownedWinnerAdsetIds` before re-testing a creative or unpausing an adset.

**Distinct from** [[cold-scaler-cohort]] — that SDK reads the SCALER-rail CAMPAIGN configuration (does a scaler exist for this tuple, what's the ceiling); this SDK reads/writes the per-adset CROWN LEDGER (which specific test adset earned the scaler slot).

## Exports

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

## Related

- [[../tables/media_buyer_crowned_winners]] — the backing table.
- [[meta-cpa-signal]] — Phase 2 wires `detectMetaCpaReactivations` to exclude crowned adsets via `listCrownedWinnerAdsetIds`.
- [[cold-scaler-cohort]] — sibling SDK for the SCALER-rail cohort (campaign configuration + ceiling).
- [[../specs/media-buyer-persist-crowned-winners-and-guard-reactivation]] — the introducing spec.
