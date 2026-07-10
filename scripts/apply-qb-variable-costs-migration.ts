import { pgClient } from "./_bootstrap";
import { readFileSync } from "fs"; import { resolve } from "path";
async function main(){
  const sql=readFileSync(resolve(__dirname,"../supabase/migrations/20261010130000_qb_pnl_variable_costs.sql"),"utf8");
  const c=pgClient(); await c.connect();
  try{ await c.query(sql); console.log("✓ applied"); const {rows}=await c.query("select column_name from information_schema.columns where table_name='qb_pnl_snapshots' and column_name in ('digital_advertising','transaction_fees')"); console.log(rows);}finally{await c.end();}
}
main().catch(e=>{console.error(e);process.exit(1);});
