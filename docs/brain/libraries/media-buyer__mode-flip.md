# media-buyer/mode-flip

The tiny shared compare-and-set that flips the workspace's active v1 [[../tables/iteration_policies]] row between `mode='armed'` and `mode='shadow'`. Extracted so the owner arm/disarm route AND the [[./media-buyer-self-correcting]] auto-revert drive the SAME mutation ([[../specs/media-buyer-self-correcting-mode-revert]] Phase 1).

**File:** `src/lib/media-buyer/mode-flip.ts`

## Contract

```ts
export type MediaBuyerPolicyMode = "armed" | "shadow";

export interface FlipMediaBuyerPolicyModeResult {
  ok: boolean;
  updatedIds: string[];
  error?: string;
}

export function flipMediaBuyerPolicyMode(
  admin,
  workspaceId: string,
  targetMode: MediaBuyerPolicyMode,
): Promise<FlipMediaBuyerPolicyModeResult>
```

Scope: `.eq('workspace_id', ws).eq('status','active').is('campaign_id', null).select('id')` — the v1 workspace-scope rows (matches [[./iteration-policy-authoring]]).

## Callers

- `src/app/api/growth/media-buyer/arm/route.ts` — the owner arm + disarm surface.
- [[./media-buyer-self-correcting]] `checkMediaBuyerRegressionAndDisarm` — the auto-revert.

## Gotchas

- **Never throws.** A raced flip (0 rows transitioned) resolves as `{ ok: true, updatedIds: [] }` so a caller's audit path can distinguish "already at target mode" from a database error.
- **Not idempotent on its own.** Both callers gate on the current mode BEFORE calling; the helper unconditionally issues the UPDATE against the compare-and-set scope.

## Related

[[../tables/iteration_policies]] · [[./media-buyer-self-correcting]] · [[../specs/media-buyer-self-correcting-mode-revert]] · [[../specs/media-buyer-armed-flip-surface]]
