# digital_goods

The **digital-goods catalog** — one row per digital SKU-less item a cart/order line can reference: a `downloadable` e-guide (PDF delivered via email attachment on order-created — Phase 2) or a `coverage` shipping-protection add-on (nothing to deliver). Phase 1 of [[../specs/digital-goods-delivery]] under [[../functions/platform]] · [[../functions/platform#store-tech--shopify]].

A digital-good line carries **no fulfillable sku** on its cart/order row, so both the checkout caller's own `l.sku` filter (`src/app/api/checkout/route.ts:988`) and the defence-in-depth filter inside [[../libraries/integrations__amplifier]] `createAmplifierOrder` (`src/lib/integrations/amplifier.ts:183` — `.filter((li) => li.sku && (li.quantity ?? 0) > 0)`) already drop it before the Amplifier payload is built. Phase 1 needed no code change to satisfy that verification.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `name` | `text` | — | catalog display name (e.g. "Anti-Inflammatory Recipes E-Guide", "Shipping Protection") |
| `type` | `text` | — | CHECK ∈ `downloadable` \| `coverage` |
| `asset_path` | `text` | ✓ | Supabase Storage key (bucket-relative) · **required for `downloadable`, null for `coverage`** — enforced by the `digital_goods_asset_matches_type` CHECK |
| `delivery` | `text` | — | CHECK ∈ `attachment` \| `none` · **`downloadable` → `attachment`, `coverage` → `none`** — enforced by the `digital_goods_delivery_matches_type` CHECK |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Unique:** `(workspace_id, lower(name))` — workspace-scoped name uniqueness so the Phase 3 portal catalog UI can't render a duplicate.

**Indexes:** `digital_goods_workspace_name_uidx` (the unique above); `digital_goods_workspace_idx` on `(workspace_id)` — Phase 3 portal-resend catalog lookup.

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id.

## Invariants

- **Two legal row shapes, pinned at the DB.** A row is either `(type='downloadable', asset_path=<key>, delivery='attachment')` OR `(type='coverage', asset_path=null, delivery='none')`. Two CHECK constraints (`digital_goods_asset_matches_type` + `digital_goods_delivery_matches_type`) reject anything else, so Phase 2's per-row delivery loop can trust the row shape without runtime guards.
- **No fulfillment path.** A cart/order line that references a digital good MUST NOT carry a fulfillable sku on the line row — that is how [[../libraries/integrations__amplifier]] `createAmplifierOrder` (and its checkout caller) skip it. This table intentionally has no `sku` column: a digital good is not a warehouse item.
- **Admin-only.** RLS is ON with a `service_role`-only policy — every read/write goes through server-side code via `createAdminClient()`. There is no anon read path.
- **`asset_path` is a server-only key.** The value is read from Supabase Storage server-side once at delivery (Phase 2's Inngest attachment step) and never signed to the customer — the customer receives the file as an email attachment, not a link.

## Queries

**Digital goods for a workspace's catalog UI.** (Phase 3 planned)
```ts
const { data } = await admin
  .from("digital_goods")
  .select("id, name, type, delivery")
  .eq("workspace_id", workspaceId)
  .order("name", { ascending: true });
```

**Resolve a cart-line reference for Phase 2 delivery.** (planned)
```ts
const { data } = await admin
  .from("digital_goods")
  .select("id, name, type, asset_path, delivery")
  .eq("workspace_id", workspaceId)
  .eq("id", digitalGoodId)
  .single();
```

## RLS

**On, admin-only.** `digital_goods_service` policy grants `service_role` full access; every read/write flows through server-side code via `createAdminClient()`. No anon / member read path.

## Callers

- **[[../libraries/integrations__amplifier]] `createAmplifierOrder`** — does **not** read this table. A digital-good line has no `sku` on its cart/order row, and both the checkout caller (`src/app/api/checkout/route.ts:988`) and the amplifier filter (`src/lib/integrations/amplifier.ts:183`) drop sku-less lines before the payload is built. Zero rows for a digital good in the Amplifier payload is Phase 1's verification statement.
- **Phase 2 (planned)** — the order-created Inngest function will read `(id, asset_path, delivery)` per digital-good line and send exactly one attachment email via Resend, idempotent per `(order, digital_good)`.
- **Phase 3 (planned)** — the customer portal resend action.

## Status / open work

- ✅ Phase 1 — catalog table
- ⏳ Phase 2 — post-purchase attachment delivery (Inngest on order-created)
- ⏳ Phase 3 — portal resend action

---

[[../README]] · [[workspaces]] · [[../libraries/integrations__amplifier]] · [[../specs/digital-goods-delivery]] · [[../../CLAUDE]]
