-- Atomic per-workspace SHOPCX order-number counter.
-- Replaces the racy max-and-increment in generateOrderNumber, which let two
-- concurrent internal-subscription renewals both claim SHOPCX6 (Sharon
-- Mogliotti, 2026-06-12). Amplifier keys fulfillment on order_id, so the
-- duplicate stranded one order from the 3PL (it never shipped).

create table if not exists order_number_counters (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  next_value bigint not null default 1
);
alter table order_number_counters enable row level security;

-- Seed from the current max SHOPCX number per workspace so we never reissue one.
insert into order_number_counters (workspace_id, next_value)
select workspace_id, max((substring(order_number from 7))::bigint) + 1
from orders
where order_number ~ '^SHOPCX[0-9]+$'
group by workspace_id
on conflict (workspace_id) do update
  set next_value = greatest(order_number_counters.next_value, excluded.next_value);

-- Atomic claim: increments under a row lock and returns the claimed integer.
create or replace function claim_order_number(p_workspace_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare claimed bigint;
begin
  insert into order_number_counters (workspace_id, next_value)
  values (p_workspace_id, 2)
  on conflict (workspace_id) do update
    set next_value = order_number_counters.next_value + 1
  returning next_value - 1 into claimed;
  return claimed;
end;
$$;
