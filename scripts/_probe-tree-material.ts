// READ-ONLY probe: per-ticket clustering material.
import { pgClient } from "./_bootstrap";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const q = async (label: string, sql: string) => {
      const r = await c.query(sql);
      console.log(`\n== ${label} ==`);
      console.table(r.rows);
    };

    await q("ticket_messages author_type x direction x visibility", `
      select author_type, direction, visibility, count(*) as n
      from ticket_messages group by 1,2,3 order by 4 desc limit 20`);

    // what do the non-matching Action notes look like?
    const r1 = await c.query(`
      select left(body, 90) as head, count(*) as n
      from ticket_messages
      where author_type='system' and body like 'Action %'
        and substring(body from 'Action (?:completed|failed): ([a-z_]+)') is null
      group by 1 order by 2 desc limit 25`);
    console.log("\n== unmatched Action notes =="); console.table(r1.rows);

    // system note prefixes generally
    const r2 = await c.query(`
      select left(body, 40) as head, count(*) as n
      from ticket_messages where author_type='system'
      group by 1 order by 2 desc limit 30`);
    console.log("\n== system note heads =="); console.table(r2.rows);

    await q("ticket_analyses columns", `
      select column_name, data_type from information_schema.columns
      where table_name='ticket_analyses' order by ordinal_position`);

    await q("ticket_analyses coverage", `
      select count(*) as n, count(distinct ticket_id) as tickets,
             min(created_at)::date as first, max(created_at)::date as last
      from ticket_analyses`);

    await q("journey_sessions per journey", `
      select jd.name, count(*) as n
      from journey_sessions js join journey_definitions jd on jd.id = js.journey_id
      group by 1 order by 2 desc limit 25`);

    await q("subject sample (canonical, random 30)", `
      select left(coalesce(subject,'<null>'),70) as subject, channel
      from tickets where merged_into is null
      order by random() limit 30`);

    await q("first-inbound presence", `
      select count(*) as canonical,
        count(*) filter (where exists (
          select 1 from ticket_messages m where m.ticket_id=t.id
            and m.direction='inbound' and m.author_type='customer')) as has_customer_inbound
      from tickets t where merged_into is null`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
