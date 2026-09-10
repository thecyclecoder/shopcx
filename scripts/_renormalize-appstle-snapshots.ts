/**
 * Re-derive every snapshot's `lines` projection from its own `raw` payload.
 *
 * Costs ZERO vendor calls — which is the entire point of storing `raw` as authoritative and the
 * typed columns as a re-derivable projection. Run this whenever `normalizeAppstleContract` gains a
 * field, instead of re-paying for 2,477 metered Appstle reads.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const apply = process.argv.includes("--apply");
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { normalizeAppstleContract } = await import("../src/lib/appstle-snapshot");
  const admin = createAdminClient();

  const rows: { appstle_contract_id: string; raw: Record<string, unknown> | null }[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await admin
      .from("appstle_contract_snapshots").select("appstle_contract_id, raw")
      .eq("workspace_id", WORKSPACE_ID).order("appstle_contract_id", { ascending: true })
      .range(from, from + 499);
    if (error) throw new Error(`select failed: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as typeof rows));
    if (data.length < 500) break;
  }

  let changed = 0, noRaw = 0;
  for (const r of rows) {
    if (!r.raw) { noRaw++; continue; }
    const norm = normalizeAppstleContract(r.raw as Record<string, never>);
    const withCodes = norm.lines.filter((l) => (l.code_allocation_unit_cents ?? 0) > 0).length;
    if (withCodes) changed++;
    if (apply) {
      const { error } = await admin.from("appstle_contract_snapshots")
        .update({ lines: norm.lines })
        .eq("workspace_id", WORKSPACE_ID).eq("appstle_contract_id", r.appstle_contract_id);
      if (error) throw new Error(`update ${r.appstle_contract_id} failed: ${error.message}`);
    }
  }
  console.log(`snapshots: ${rows.length}   no raw: ${noRaw}`);
  console.log(`carrying >=1 customer-code allocation: ${changed}`);
  console.log(apply ? "re-derived and written." : "DRY — pass --apply to write.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
