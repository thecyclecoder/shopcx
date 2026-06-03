import { readFileSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  if (!process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
}

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

(async () => {
  const password = process.env.SUPABASE_DB_PASSWORD!;
  const host = process.env.SUPABASE_DB_HOST || "aws-1-us-east-1.pooler.supabase.com";
  const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@${host}:6543/postgres`;
  const c = new Client({ connectionString: cs });
  await c.connect();

  // 1. Distinct titles containing "Amazing Coffee" to confirm the matching set.
  const titlesRes = await c.query(`
    SELECT DISTINCT li->>'title' AS title, COUNT(*) AS order_count
    FROM orders, jsonb_array_elements(line_items) li
    WHERE workspace_id = $1::uuid
      AND li->>'title' ILIKE '%amazing coffee%'
    GROUP BY 1
    ORDER BY 2 DESC
  `, [WS]);
  console.log("Distinct Amazing Coffee line-item titles:");
  for (const r of titlesRes.rows) console.log(`  ${String(r.order_count).padStart(6)}  ${r.title}`);

  // 2. Unique customers with at least one Amazing Coffee line item.
  const custRes = await c.query(`
    SELECT DISTINCT o.customer_id
    FROM orders o, jsonb_array_elements(o.line_items) li
    WHERE o.workspace_id = $1::uuid
      AND o.customer_id IS NOT NULL
      AND li->>'title' ILIKE '%amazing coffee%'
  `, [WS]);
  const customerIds: string[] = custRes.rows.map(r => r.customer_id);
  console.log(`\nUnique Amazing Coffee customers: ${customerIds.length}`);

  // 3. Demographic rows for those customers.
  const demoRes = await c.query(`
    SELECT customer_id, inferred_gender, inferred_age_range, zip_income_bracket,
           zip_median_income, inferred_life_stage, buyer_type, health_priorities
    FROM customer_demographics
    WHERE workspace_id = $1::uuid
      AND customer_id = ANY($2::uuid[])
  `, [WS, customerIds]);
  const demoRows = demoRes.rows;
  console.log(`Demographics rows: ${demoRows.length}  (coverage: ${((demoRows.length / Math.max(customerIds.length, 1)) * 100).toFixed(1)}%)`);

  function bucket(field: string): Map<string, number> {
    const m = new Map<string, number>();
    for (const r of demoRows) {
      const v = r[field];
      if (v === null || v === undefined || v === "") { m.set("(unknown)", (m.get("(unknown)") || 0) + 1); continue; }
      m.set(String(v), (m.get(String(v)) || 0) + 1);
    }
    return m;
  }
  function pct(m: Map<string, number>, total: number) {
    return [...m.entries()].sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `  ${k.padEnd(25)} ${String(v).padStart(5)}  ${((v / total) * 100).toFixed(1).padStart(5)}%`).join("\n");
  }
  const total = demoRows.length || 1;
  console.log("\n— Age range —");           console.log(pct(bucket("inferred_age_range"), total));
  console.log("\n— Gender —");              console.log(pct(bucket("inferred_gender"), total));
  console.log("\n— ZIP income bracket —");  console.log(pct(bucket("zip_income_bracket"), total));
  console.log("\n— Inferred life stage —"); console.log(pct(bucket("inferred_life_stage"), total));
  console.log("\n— Buyer type —");          console.log(pct(bucket("buyer_type"), total));

  const incomes = demoRows.map(r => r.zip_median_income).filter((n: any): n is number => typeof n === "number").sort((a: number, b: number) => a - b);
  const median = incomes.length ? incomes[Math.floor(incomes.length / 2)] : null;
  const mean   = incomes.length ? Math.round(incomes.reduce((a: number, b: number) => a + b, 0) / incomes.length) : null;
  console.log(`\nZIP median income: median $${median?.toLocaleString()}, mean $${mean?.toLocaleString()}, n=${incomes.length}`);

  const priors = new Map<string, number>();
  for (const r of demoRows) for (const p of (r.health_priorities || []) as string[]) priors.set(p, (priors.get(p) || 0) + 1);
  console.log("\n— Top health priorities —");
  console.log([...priors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([k, v]) => `  ${k.padEnd(30)} ${String(v).padStart(5)}  ${((v / total) * 100).toFixed(1).padStart(5)}%`).join("\n") || "  (none)");

  await c.end();
})();
