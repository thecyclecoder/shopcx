import { readFileSync } from "fs"; import { resolve } from "path"; import { pgClient } from "./_bootstrap";
async function main(){const c=pgClient();await c.connect();try{
  await c.query(readFileSync(resolve(__dirname,"../supabase/migrations/20260705160000_dashboard_notifications_agent_types.sql"),"utf8"));
  console.log("✓ applied constraint fix");
  const {rows}=await c.query(`select pg_get_constraintdef(oid) def from pg_constraint where conname='dashboard_notifications_type_check'`);
  console.log("new CHECK:", rows[0].def.includes("agent_approval_request") ? "includes agent types ✓" : "MISSING agent types ✗");
}finally{await c.end();}}
main().catch(e=>{console.error(e.message);process.exit(1);});
