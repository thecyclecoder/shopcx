import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  // resolve Amazing Coffee product id
  const { data: prods } = await admin
    .from("products")
    .select("id,title,handle")
    .eq("workspace_id", WS)
    .ilike("title", "%coffee%");
  console.log("coffee candidates:", JSON.stringify(prods, null, 2));
  const coffee = (prods ?? []).find((p) => /amazing coffee/i.test(p.title)) ?? (prods ?? [])[0];
  if (!coffee) { console.log("no coffee product found"); return; }
  console.log("using product:", coffee.id, coffee.title);

  const { data: job, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: WS,
      kind: "ad-creative",
      status: "queued",
      spec_slug: `ad-creative:${coffee.id}`,
      instructions: JSON.stringify({ product_id: coffee.id, count: 4 }),
    })
    .select("id,status,kind,created_at")
    .single();
  if (error) { console.error("insert error:", error); return; }
  console.log("enqueued job:", JSON.stringify(job, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
