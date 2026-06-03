import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"),"utf8").split("\n")) {
  const t=line.trim(); if(!t||t.startsWith("#")) continue;
  const eq=t.indexOf("="); if(eq<0) continue;
  if(!process.env[t.slice(0,eq)]) process.env[t.slice(0,eq)]=t.slice(eq+1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const RULE_ID = "0d75ac46-4338-47f2-aba6-8235910f98e2";
const footer = `\n\n---\n\nApp-permission context: our Meta app is in review for upgraded webhook permissions that may eventually expose customer email in the inbound payload. Even if approved, this rule stays — Meta delivery of email is best-effort (user has to grant the right scopes, app has to be approved, profile has to expose it), so verify-by-email-or-order# remains the reliable identification path.`;

async function main() {
  const { data: row } = await sb.from("sonnet_prompts").select("content").eq("id", RULE_ID).single();
  const merged = (row?.content || "") + footer;
  const { data, error } = await sb.from("sonnet_prompts").update({ content: merged, updated_at: new Date().toISOString() }).eq("id", RULE_ID).select("id, title").single();
  if (error) { console.error(error); process.exit(1); }
  console.log("✓ Appended footer:", data);
}
main().catch(e=>{console.error(e); process.exit(1);});
