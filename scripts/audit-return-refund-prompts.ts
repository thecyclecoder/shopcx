/**
 * Pull all enabled sonnet_prompts that mention returns/refunds and
 * dump their full content so we can derive the actual policy the
 * orchestrator is operating under.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const KEYWORD = /\b(refund|return|void|chargeback|money[\s-]?back|guarantee|30[\s-]?day|partial[\s-]?refund|store[\s-]?credit|reship|replacement)\b/i;

async function main() {
  const { data: prompts } = await admin
    .from("sonnet_prompts")
    .select("id, title, category, enabled, content, sort_order, updated_at")
    .order("category")
    .order("sort_order");

  const hits = (prompts || []).filter(p => KEYWORD.test(p.content || "") || KEYWORD.test(p.title || ""));
  console.log(`Total prompts: ${prompts?.length || 0}`);
  console.log(`Return/refund-relevant: ${hits.length} (${hits.filter(p => p.enabled).length} enabled)\n`);

  for (const p of hits) {
    console.log(`─────────────────────────────────────────────────────────`);
    console.log(`[${p.category}${p.enabled ? "" : " — DISABLED"}] ${p.title}`);
    console.log(`  id=${p.id}  sort_order=${p.sort_order}  updated=${p.updated_at}`);
    console.log("");
    const content = (p.content || "").trim();
    // Print full content
    console.log(content);
    console.log("");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
