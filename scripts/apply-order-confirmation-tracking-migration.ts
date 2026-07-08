// apply-order-confirmation-tracking-migration — Phase 3 of
// shopify-order-confirmation-emails. Adds the tracking columns the
// Phase-4 sender stamps + the email_events↔orders FK so the Resend
// events pipeline can attribute delivered/opened back to the order.
//
// Additive + nullable; idempotent via IF NOT EXISTS. Runs the
// migration file's statements against the pooler.
//   npx tsx scripts/apply-order-confirmation-tracking-migration.ts
import { pgClient } from "./_bootstrap";

const STATEMENTS = [
  `alter table public.orders
     add column if not exists order_confirmation_email_id text null,
     add column if not exists order_confirmation_sent_at timestamptz null`,
  `alter table public.email_events
     add column if not exists order_id uuid null
       references public.orders(id) on delete set null`,
  `create index if not exists email_events_order_id_idx
     on public.email_events (order_id)
     where order_id is not null`,
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const sql of STATEMENTS) {
      await c.query(sql);
      console.log(`✓ ${sql.trim().split("\n")[0]} …`);
    }
    const { rows } = await c.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and ((table_name = 'orders' and column_name in ('order_confirmation_email_id','order_confirmation_sent_at'))
           or (table_name = 'email_events' and column_name = 'order_id'))
       order by table_name, column_name`,
    );
    console.log("✓ present:", rows.map((r) => `${r.table_name}.${r.column_name}`));
    const { rows: idxs } = await c.query(
      `select indexname from pg_indexes
       where schemaname = 'public' and tablename = 'email_events' and indexname = 'email_events_order_id_idx'`,
    );
    console.log(
      "✓ index:",
      idxs.length ? "email_events_order_id_idx present" : "MISSING",
    );
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
