import { createAdminClient } from "./_bootstrap";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const { data } = await admin
    .from("amazon_asins")
    .select("asin, sku, title, status, product_id, amazon_connection_id")
    .eq("workspace_id", WORKSPACE_ID)
    .order("status", { ascending: true });

  const rows = data || [];
  const active = rows.filter((r) => (r.status || "").toLowerCase() === "active");
  console.log(`total asin rows: ${rows.length} | active: ${active.length}`);
  for (const r of rows) {
    console.log(
      `${r.status?.padEnd(9)} ${r.asin}  sku=${(r.sku || "-").padEnd(16)} ${(r.title || "").slice(0, 70)}`,
    );
  }
}

main().then(() => process.exit(0));
