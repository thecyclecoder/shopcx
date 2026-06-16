-- Checkout customize-bypass: when true, PDP pack-select goes straight to /checkout
-- (skipping the /customize worksheet). A "Customize your order" button on checkout
-- is the opt-in escape hatch. Reversible / A-B-toggleable per workspace.
alter table public.workspaces add column if not exists storefront_skip_customize boolean not null default false;

-- Superfoods: bypass on.
update public.workspaces set storefront_skip_customize = true where id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906';
