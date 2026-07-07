-- create_digital_goods — Phase 1 of digital-goods-delivery.
--
-- The catalog of digital goods (e-guides, shipping-protection add-ons) that a
-- cart / order line can reference. A digital-good line carries NO fulfillable
-- sku on its cart/order row, so the amplifier caller's own `l.sku` filter in
-- src/app/api/checkout/route.ts:988 AND the defence-in-depth filter in
-- src/lib/integrations/amplifier.ts:183 (`.filter((li) => li.sku && ...)`)
-- BOTH already drop it before the Amplifier payload is built — Phase 1 needs
-- no code change to satisfy that half of the verification. This migration
-- adds only the catalog table itself; Phase 2 wires the order-created Inngest
-- attachment-email delivery and Phase 3 the portal-resend action.
--
-- Additive, idempotent (IF NOT EXISTS + drop/create policy). RLS ENABLED with
-- a service_role full-access policy (house convention shared with the newer
-- order_refunds migration — every read/write flows through server-side code
-- via createAdminClient(); no anon read path). Satisfies check:rls-on-new-tables.

create table if not exists public.digital_goods (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  name          text not null,
  type          text not null check (type in ('downloadable', 'coverage')),
  asset_path    text null,
  delivery      text not null check (delivery in ('attachment', 'none')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Phase-1 invariant: a `downloadable` good MUST have an asset_path (that's the
-- file Phase 2 reads from Supabase Storage and attaches). A `coverage` good
-- (shipping protection) MUST NOT (nothing to deliver). Enforced at the DB so a
-- mis-shaped seed can't slip past Phase 2's per-row loop and fire an empty email.
alter table public.digital_goods
  drop constraint if exists digital_goods_asset_matches_type;
alter table public.digital_goods
  add constraint digital_goods_asset_matches_type check (
    (type = 'downloadable' and asset_path is not null)
    or (type = 'coverage' and asset_path is null)
  );

-- Same rule for delivery: `downloadable` → `attachment` (the only channel Phase 2
-- ships); `coverage` → `none` (nothing to send). Together with the asset-path
-- constraint this pins the two legal row shapes.
alter table public.digital_goods
  drop constraint if exists digital_goods_delivery_matches_type;
alter table public.digital_goods
  add constraint digital_goods_delivery_matches_type check (
    (type = 'downloadable' and delivery = 'attachment')
    or (type = 'coverage' and delivery = 'none')
  );

-- Workspace-scoped uniqueness on name — Phase 2's cart/order line reference
-- resolves by (workspace_id, digital_good.id), but a duplicate name inside one
-- workspace would confuse the human-facing catalog UI planned for Phase 3.
create unique index if not exists digital_goods_workspace_name_uidx
  on public.digital_goods (workspace_id, lower(name));

-- Workspace-scoped list index (Phase 3 portal-resend catalog lookup).
create index if not exists digital_goods_workspace_idx
  on public.digital_goods (workspace_id);

alter table public.digital_goods enable row level security;
drop policy if exists digital_goods_service on public.digital_goods;
create policy digital_goods_service on public.digital_goods
  for all to service_role using (true) with check (true);

comment on table public.digital_goods is
  'Digital goods catalog — one row per downloadable e-guide or shipping-protection coverage item. Phase 1 of digital-goods-delivery. A cart/order line referencing a digital good carries NO fulfillable sku (see src/app/api/checkout/route.ts + src/lib/integrations/amplifier.ts sku filter), so it never reaches Amplifier. See docs/brain/tables/digital_goods.md.';
comment on column public.digital_goods.type is
  'downloadable = a file customer receives (Phase 2 emails asset_path as attachment via Resend) | coverage = shipping-protection add-on (nothing to deliver).';
comment on column public.digital_goods.asset_path is
  'Supabase Storage key (bucket-relative) — required for downloadable, null for coverage. Read server-side once at delivery time (Phase 2), never signed to the customer.';
comment on column public.digital_goods.delivery is
  'attachment = email PDF via Resend at order-created (Phase 2) | none = no delivery channel (coverage lines). Constrained to match type.';
