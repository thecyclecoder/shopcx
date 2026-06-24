import { readFileSync } from "fs"; import { resolve } from "path"; import { pgClient } from "./_bootstrap";
async function main(){const c=pgClient();await c.connect();try{
  await c.query(readFileSync(resolve(__dirname,"../supabase/migrations/20260705150000_worker_to_agent_rename.sql"),"utf8"));
  console.log("✓ applied rename");
  const {rows}=await c.query("select table_name from information_schema.tables where table_name in ('agent_action_grades','agent_grader_prompts','agent_instructions','agent_coaching_log','worker_action_grades','worker_instructions') order by table_name");
  console.log("tables now:", rows.map(r=>r.table_name));
}finally{await c.end();}}
main().catch(e=>{console.error(e.message);process.exit(1);});
