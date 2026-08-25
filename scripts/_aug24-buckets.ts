/** Bucket raw website orders for the last 5 days to confirm the daily snapshot isn't lagging. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
import { bucketOrder, type OrderBucket } from "../src/lib/order-bucketing";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  for (const d of ["2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25"]) {
    const rows: Array<{ source_name: string | null; tags: string | null; subscription_id: string | null; total_cents: number | null }> = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await admin.from("orders")
        .select("source_name,tags,subscription_id,total_cents")
        .eq("workspace_id", WS)
        .gte("created_at", `${d}T00:00:00-05:00`)
        .lt("created_at", `${d}T23:59:59.999-05:00`)
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as typeof rows));
      if (!data || data.length < 1000) break;
    }
    const c: Record<OrderBucket, number> = { recurring: 0, new_sub: 0, one_time: 0, replacement: 0 };
    let acqRev = 0;
    for (const r of rows) {
      const b = bucketOrder(r);
      c[b] += 1;
      if (b === "new_sub" || b === "one_time") acqRev += Number(r.total_cents ?? 0) / 100;
    }
    const acq = c.new_sub + c.one_time;
    console.log(`${d}  total ${String(rows.length).padStart(3)}  |  ACQ ${String(acq).padStart(2)} (new_sub ${c.new_sub} + one_time ${c.one_time})  renewals ${String(c.recurring).padStart(2)}  repl ${c.replacement}  |  acq rev $${acqRev.toFixed(0)}  AOV $${acq ? (acqRev / acq).toFixed(0) : "—"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
