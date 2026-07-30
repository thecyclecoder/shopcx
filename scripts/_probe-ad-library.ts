import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  // status distribution (the database is the spec — see the real enum values)
  const { data: rows, error } = await admin
    .from("ad_campaigns")
    .select("id,status,product_id,meta_campaign_id,meta_adset_id,published_at,angle_id,name,created_at")
    .eq("workspace_id", WS);
  if (error) throw new Error(error.message);
  const byStatus = new Map<string, { n: number; withMetaAdset: number; withPublishedAt: number }>();
  for (const r of rows || []) {
    const s = String(r.status ?? "null");
    const e = byStatus.get(s) || { n: 0, withMetaAdset: 0, withPublishedAt: 0 };
    e.n++;
    if ((r as any).meta_adset_id || (r as any).meta_campaign_id) e.withMetaAdset++;
    if ((r as any).published_at) e.withPublishedAt++;
    byStatus.set(s, e);
  }
  console.log(`ad_campaigns for workspace ${WS}: ${rows?.length ?? 0} rows\n`);
  console.log("status".padEnd(16), "count".padEnd(7), "has_meta_id".padEnd(12), "has_published_at");
  for (const [s, e] of [...byStatus.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(s.padEnd(16), String(e.n).padEnd(7), String(e.withMetaAdset).padEnd(12), String(e.withPublishedAt));
  }
  // show a couple sample columns to confirm which columns actually exist
  console.log("\nsample row keys:", rows && rows[0] ? Object.keys(rows[0]).join(", ") : "(none)");
}
main().catch((e) => { console.error(e); process.exit(1); });
