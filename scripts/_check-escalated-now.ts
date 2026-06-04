import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"),"utf8").split("\n")) {
  const t=line.trim(); if(!t||t.startsWith("#")) continue;
  const eq=t.indexOf("="); if(eq<0) continue;
  if(!process.env[t.slice(0,eq)]) process.env[t.slice(0,eq)]=t.slice(eq+1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const { data } = await sb.from("tickets").select("id, status, escalated_at, subject, escalated_to").eq("workspace_id", "fdc11e10-b89f-4989-8b73-ed6526c4d906").not("escalated_at", "is", null).order("escalated_at", { ascending: false }).limit(20);
  console.log(`escalated tickets: ${data?.length}`);
  for (const t of data || []) console.log(`  ${t.id.slice(0,8)} ${t.status.padEnd(8)} esc=${t.escalated_at?.slice(0,16)} to=${t.escalated_to?.slice(0,8) || "null"} "${t.subject}"`);

  // Also see if any already have todos
  const { data: tds } = await sb.from("agent_todos").select("source_ticket_id, status, action_type").not("source_ticket_id", "is", null);
  console.log(`\ntodos with source_ticket_id: ${tds?.length || 0}`);
  for (const r of tds || []) console.log(`  src=${r.source_ticket_id?.slice(0,8)} ${r.status} ${r.action_type}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
