import { pgClient } from "./_bootstrap";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const c=pgClient(); await c.connect();
  // Funnel, so we can see where candidates are lost rather than just the final number.
  const sql = `
  with orders_in_window as (
    select o.id, o.customer_id, o.created_at
    from orders o
    where o.workspace_id = $1
      and o.created_at between now() - interval '40 days' and now() - interval '10 days'
  ),
  qualified_customers as (
    select distinct ow.customer_id
    from orders_in_window ow
    join customers cu on cu.id = ow.customer_id
    where cu.ltv_cents >= 30000                                  -- $300+
      and (select count(*) from orders o2 where o2.customer_id = ow.customer_id) >= 2   -- repeat, not first-order-only
  ),
  lines as (
    select distinct ow.customer_id, li->>'product_id' shop_pid
    from orders_in_window ow
    join qualified_customers q on q.customer_id = ow.customer_id
    join orders o on o.id = ow.id, lateral jsonb_array_elements(o.line_items) li
    where li->>'product_id' is not null
  ),
  pairs as (
    select l.customer_id, p.id product_id, p.title
    from lines l join products p on p.shopify_product_id = l.shop_pid
  )
  select
    (select count(*) from orders_in_window)::int                                        as orders_in_window,
    (select count(distinct customer_id) from orders_in_window)::int                     as customers_in_window,
    (select count(*) from qualified_customers)::int                                     as ltv300_and_repeat,
    (select count(*) from pairs)::int                                                   as customer_product_pairs,
    (select count(*) from pairs pr join products p on p.id=pr.product_id where p.reviewable)::int as reviewable_pairs,
    (select count(*) from pairs pr join products p on p.id=pr.product_id where p.reviewable
       and not exists (select 1 from product_reviews r where r.customer_id=pr.customer_id and r.product_id=pr.product_id))::int as not_yet_reviewed,
    (select count(*) from pairs pr join products p on p.id=pr.product_id join customers cu on cu.id=pr.customer_id
       where p.reviewable
       and not exists (select 1 from product_reviews r where r.customer_id=pr.customer_id and r.product_id=pr.product_id)
       and not exists (select 1 from review_requests rq where rq.customer_id=pr.customer_id and rq.product_id=pr.product_id)
       and (cu.email_marketing_status <> 'unsubscribed' and cu.email is not null
            or cu.sms_marketing_status = 'subscribed' and cu.phone is not null))::int as SENDABLE
  `;
  const { rows } = await c.query(sql, [WS]);
  const f = rows[0];
  console.log("── funnel: orders 10–40 days ago, LTV ≥ $300, repeat buyers");
  for (const [k,v] of Object.entries(f)) console.log(`  ${String(v).padStart(6)}  ${k}`);
  await c.end();
}
main();
