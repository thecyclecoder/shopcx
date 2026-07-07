import { loadEnv } from "./_bootstrap";
loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  for (const slug of ["add-payment-method-journey", "assisted-purchase-playbook"]) {
    const s = await getSpec(WS, slug);
    if (!s) { console.log(slug, "NOT FOUND"); continue; }
    console.log("—", slug);
    console.log("   status:", s.status, "| intended:", (s as any).intended_status, "| owner:", (s as any).owner_function ?? (s as any).owner);
    console.log("   parent:", (s as any).parent_ref ?? (s as any).parent, "| blocked_by:", JSON.stringify((s as any).blocked_by));
    console.log("   vale_pass:", (s as any).vale_pass, "| phases:", (s.phases||[]).length);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
