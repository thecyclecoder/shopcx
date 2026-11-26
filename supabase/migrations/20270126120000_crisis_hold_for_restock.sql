-- crisis_customer_actions.hold_for_restock
-- Records that a customer DECLINED the substitute flavor during a crisis and
-- chose to wait for their original flavor to come back in stock. Without this
-- flag every later automation (notably the restart swap) reads such a customer
-- as having accepted the swap (tier1_response='accepted_swap') and silently
-- swaps + charges them. See spec crisis-restart-swap-respects-wait-for-restock.
alter table public.crisis_customer_actions
  add column if not exists hold_for_restock boolean not null default false;
