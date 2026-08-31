/** The exact source review behind the ad's testimonial. Full text, no truncation. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();
  const { data, error } = await a.from("product_reviews")
    .select("id,reviewer_name,rating,title,body,smart_quote,created_at,published_at,verified_purchase,product_name,featured,status")
    .eq("workspace_id", WS).ilike("body", "%50 pounds%").ilike("body", "%18 months%");
  if (error) throw new Error(`product_reviews: ${error.message}`);
  console.log(`reviews containing BOTH "50 pounds" and "18 months": ${(data ?? []).length}\n`);
  for (const r of data ?? []) {
    console.log(`── ${r.reviewer_name} · ${r.rating}★ · ${r.product_name} · verified=${r.verified_purchase} · status=${r.status} · featured=${r.featured}`);
    console.log(`   created ${String(r.created_at).slice(0, 10)}  published ${String(r.published_at ?? "—").slice(0, 10)}`);
    console.log(`   title: ${r.title ?? "—"}`);
    console.log(`   BODY: ${r.body}`);
    console.log(`   smart_quote: ${r.smart_quote ?? "—"}\n`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
