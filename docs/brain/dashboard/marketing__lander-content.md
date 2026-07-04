# Dashboard · marketing/landers/content

The founder-facing upload surface for Cleo's teardown → build-new lander pipeline. Every [[../tables/lander_blueprints]] row in `awaiting_upload` shows up here with its open [[../tables/lander_content_gaps]] — Carrie's plain-language asks for real-evidence assets she can't ethically generate (a real before/after, a UGC selfie, a testimonial photo, a press logo). One drag-drop card per gap; on upload the asset lands in [[../tables/product_media]] (permanent product intelligence, keyed by category + source='uploaded'), the gap flips resolved, and when the last gap on a blueprint clears the row advances to `content_complete` — which fires the deterministic verify + build-spec handoff (see [[../lifecycles/lander-from-teardown]]).

**Route:** `/dashboard/marketing/landers/content` · **Owner:** [[../functions/growth]] · **Parent:** [[../goals/acquisition-research-engine]]

## Features

**Page title:** Lander content uploads

**Rendering:** `"use client"` component. Fetches the workspace's `awaiting_upload` blueprints + open gaps on mount; per gap renders a drag-drop uploader that POSTs multipart to the gap resolve endpoint. On success the card flips to a resolved state with a thumbnail — no page reload. When the server signals `blueprint_complete: true` (the LAST open gap on a blueprint), the blueprint header switches to a "Content complete — build queued" chip.

**Per blueprint card** — the target product's title + Carrie's rationale (why this blueprint was worth the founder's attention) + one card per open [[../tables/lander_content_gaps]] row. Each gap card shows:

- The persuasive-job asset role (before/after · UGC selfie · testimonial photo · press logo).
- The `block_ref` it feeds (matches a `skeleton.blocks[].role` on the blueprint).
- Carrie's plain-language description — the founder-facing ask, no jargon.
- A snippet of the block's copy so the founder can eyeball what the asset lands next to.
- The drag-drop uploader (accepts image/* + video/mp4 + video/quicktime).

## Sub-routes

_None._

## API endpoints called

- `GET /api/marketing/landers/blueprints?workspaceId=…` — full list, one blueprint per card + open gaps.
- `GET /api/marketing/landers/blueprints?workspaceId=…&count=1` — cheap badge probe (`{ pending_uploads: N }`) used by the sidebar amber badge.
- `POST /api/marketing/landers/gaps/[id]/upload?workspaceId=…` — multipart upload; stores in the `product-media` bucket, upserts a categorized [[../tables/product_media]] row via [[../libraries/lander-blueprints]] `writeCategorizedProductMedia`, resolves the gap via `resolveContentGap`, and (on the last gap) flips the blueprint to `content_complete` + drives the Phase 2 verify+handoff via [[../libraries/blueprint-build-submit]] `verifyAndSubmitBlueprint`. Returns `{ media, gap, blueprint_complete, build_spec_slug, handoff_outcome }`.

## Permissions

**Owner-only** (`workspace_members.role='owner'` → 403 otherwise). Mirrors the gate on `/api/research/landers` — this is the same operator surface (the founder curates Growth's cold-audience acquisition; a member without owner rights shouldn't upload the never-fake-a-customer-result assets).

## The product_media persistence path

Every upload becomes PERMANENT product intelligence, reusable across future landers:

1. **Storage.** File bytes land in the `product-media` bucket at `products/<product_id>/lander-gap/<gap_id>-<stamp>.<ext>` (see `src/app/api/marketing/landers/gaps/[id]/upload/route.ts`). The bucket is public — same one product hero galleries use ([[../libraries/product-intelligence__seed-tools]] `PRODUCT_MEDIA_BUCKET`).
2. **Row.** [[../libraries/lander-blueprints]] `writeCategorizedProductMedia` upserts a [[../tables/product_media]] row on `(workspace_id, product_id, slot, display_order)` with `slot='lander-gap-<gap_id>'`, `category=<gap.asset_role>` (the CHECK-constrained real-evidence vocabulary), `source='uploaded'`, `caption` (from the form), and `alt_text=<gap.description>`.
3. **Gap.** [[../libraries/lander-blueprints]] `resolveContentGap` flips the [[../tables/lander_content_gaps]] row to `status='resolved'` + points `resolved_media_id` at the just-upserted media id.
4. **Blueprint.** When zero open gaps remain: [[../libraries/lander-blueprints]] `setBlueprintStatus` advances the row to `content_complete`, and the route inline-calls [[../libraries/blueprint-build-submit]] `verifyAndSubmitBlueprint` (see [[../lifecycles/lander-from-teardown]] for the pass/fail branches).

## Files touched

- `src/app/dashboard/marketing/landers/content/page.tsx` — the page itself (client component; per-gap drag-drop uploader; live thumbnail on resolve; blueprint chip flip on last-gap resolve).
- `src/app/dashboard/marketing/landers/content/layout.tsx` — Suspense wrapper (required by `cacheComponents: true` — the page reads dynamic workspace-scoped data via `useWorkspace()` + client fetches).
- `src/app/api/marketing/landers/blueprints/route.ts` — GET list + `?count=1` badge.
- `src/app/api/marketing/landers/gaps/[id]/upload/route.ts` — multipart upload → product_media → resolve gap → Phase 2 verify+handoff on last gap.
- `src/app/dashboard/sidebar.tsx` — Marketing → "Lander uploads" nav item (owner-only) with an amber badge polling `?count=1`.

## Related

[[marketing__landers]] · [[../lifecycles/lander-from-teardown]] · [[../libraries/lander-blueprints]] · [[../libraries/blueprint-build-submit]] · [[../tables/lander_blueprints]] · [[../tables/lander_content_gaps]] · [[../tables/product_media]] · [[../functions/growth]] · [[../goals/acquisition-research-engine]]

---

[[../README]] · [[../../CLAUDE]]
