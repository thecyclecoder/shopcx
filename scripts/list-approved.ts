import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
async function main() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: approved } = await admin.from("sonnet_prompts")
    .select("id, category, title, content, enabled, sort_order")
    .eq("workspace_id", "fdc11e10-b89f-4989-8b73-ed6526c4d906")
    .eq("status", "approved")
    .order("category").order("sort_order");
  writeFileSync("/tmp/approved-prompts.json", JSON.stringify(approved, null, 2));
  console.log(`Wrote ${approved?.length} approved prompts to /tmp/approved-prompts.json`);

  // List approved titles inline for visual scan
  console.log("\n=== Approved titles by category ===");
  const byCat: Record<string, Array<{ title: string; id: string }>> = {};
  for (const p of approved || []) {
    if (!byCat[p.category]) byCat[p.category] = [];
    byCat[p.category].push({ title: p.title, id: p.id.slice(0, 8) });
  }
  for (const [cat, list] of Object.entries(byCat)) {
    console.log(`\n--- ${cat} (${list.length}) ---`);
    for (const p of list) console.log(`  [${p.id}] ${p.title}`);
  }

  // Also pull the rest of proposed (last one was cut off)
  const { data: prop } = await admin.from("sonnet_prompts")
    .select("id, title")
    .eq("workspace_id", "fdc11e10-b89f-4989-8b73-ed6526c4d906")
    .eq("status", "proposed")
    .order("proposed_at", { ascending: false });
  console.log("\n=== All 23 proposed (titles only) ===");
  for (const p of prop || []) console.log(`  [${p.id.slice(0,8)}] ${p.title}`);
}
main();
