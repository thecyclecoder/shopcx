import { createClient } from "@supabase/supabase-js";
async function main() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data } = await admin.from("sonnet_prompts")
    .select("id, category, title, content, proposed_at, derived_from_ticket_id")
    .eq("workspace_id", "fdc11e10-b89f-4989-8b73-ed6526c4d906")
    .eq("status", "proposed")
    .order("proposed_at", { ascending: false });
  console.log(`Proposed prompts: ${data?.length || 0}\n`);
  for (const p of data || []) {
    console.log("───");
    console.log(`[${p.id.slice(0,8)}]  ${p.category}  proposed=${p.proposed_at}  ticket=${p.derived_from_ticket_id?.slice(0,8) || "-"}`);
    console.log(`TITLE: ${p.title}`);
    console.log(p.content);
    console.log();
  }
}
main();
