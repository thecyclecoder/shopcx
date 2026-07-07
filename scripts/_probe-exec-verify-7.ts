import { pgClient } from "./_bootstrap";
async function main() {
  const c = pgClient(); await c.connect();
  try {
    for (const tid of ["8203dfe0-928a-4109-ac5e-50671bf29877","8696f11e-e331-4b23-b0af-3abb685ac407"]) {
      const m = await c.query(`select created_at, author_type, left(body,200) as b from ticket_messages where ticket_id=$1 and (body like 'Action %' or body like '[Self-heal]%' or body like '%refund%') order by created_at limit 15`, [tid]);
      console.log(`\n${tid}:`);
      for (const r of m.rows) console.log(`  ${r.created_at.toISOString()} ${r.author_type}: ${String(r.b).replace(/\n/g," ")}`);
    }
  } finally { await c.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
