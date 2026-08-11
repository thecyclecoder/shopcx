import { pgClient } from "./_bootstrap";
import { readFileSync } from "fs"; import { resolve } from "path";
async function main(){
  const sql = readFileSync(resolve(__dirname,"../supabase/migrations/20261011140000_qb_close_mappings.sql"),"utf8");
  const c = pgClient(); await c.connect();
  try{
    await c.query(sql);
    console.log("✓ migration applied");
    const { rows } = await c.query(`select table_name from information_schema.tables where table_schema='public' and table_name like 'qb_%' order by table_name`);
    console.log("qb_* tables:", rows.map((r:any)=>r.table_name).join(", "));
  } finally { await c.end(); }
}
main().catch(e=>{console.error(e);process.exit(1);});
