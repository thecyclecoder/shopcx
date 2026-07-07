// READ-ONLY probe: ticket landscape for the tree-hypothesis study.
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

    await q("overall", `
      select count(*) as total,
             count(*) filter (where merged_into is null) as canonical,
             count(*) filter (where merged_into is null and status='closed') as closed,
             min(created_at)::date as first, max(created_at)::date as last
      from tickets`);

    await q("by channel (canonical)", `
      select channel, count(*) as n,
             count(*) filter (where status='closed') as closed
      from tickets where merged_into is null
      group by 1 order by 2 desc`);

    await q("by month (canonical)", `
      select date_trunc('month', created_at)::date as month, count(*) as n
      from tickets where merged_into is null
      group by 1 order by 1`);

    await q("handled_by top 25", `
      select coalesce(handled_by,'<null>') as handled_by, count(*) as n
      from tickets where merged_into is null
      group by 1 order by 2 desc limit 25`);

    await q("tag prefixes", `
      select split_part(tag, ':', 1) as prefix, count(*) as n, count(distinct tag) as distinct_tags
      from (select unnest(tags) as tag from tickets where merged_into is null) t
      group by 1 order by 2 desc limit 25`);

    await q("j: tags top 30", `
      select tag, count(*) as n
      from (select unnest(tags) as tag from tickets where merged_into is null) t
      where tag like 'j:%' group by 1 order by 2 desc limit 30`);

    await q("pb: tags top 30", `
      select tag, count(*) as n
      from (select unnest(tags) as tag from tickets where merged_into is null) t
      where tag like 'pb:%' group by 1 order by 2 desc limit 30`);

    await q("cls:/ft: tags", `
      select tag, count(*) as n
      from (select unnest(tags) as tag from tickets where merged_into is null) t
      where tag like 'cls:%' or tag like 'ft:%' group by 1 order by 2 desc limit 20`);

    await q("action-completed note types top 30", `
      select substring(body from 'Action (?:completed|failed): ([a-z_]+)') as action, direction,
             count(*) as n
      from ticket_messages
      where author_type='system' and body like 'Action %'
      group by 1,2 order by 3 desc limit 30`);

    await q("ai_token_usage purposes top 20", `
      select split_part(purpose, ':', 1) as purpose_head, count(*) as n
      from ai_token_usage group by 1 order by 2 desc limit 20`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
