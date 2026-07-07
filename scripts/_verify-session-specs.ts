import { loadEnv } from "./_bootstrap";
loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  for (const slug of [
    "add-payment-method-journey",
    "assisted-purchase-playbook",
    "human-directives-hard-gates-over-ticket-ai",
    "ticket-merge-summary-and-context-cap",
  ]) {
    const s = await getSpec(WS, slug);
    if (!s) { console.log("✗", slug, "NOT FOUND"); continue; }
    console.log("✓", slug, "| owner:", (s as any).owner_function ?? (s as any).owner, "| intended:", (s as any).intended_status, "| blocked_by:", JSON.stringify((s as any).blocked_by), "| phases:", (s.phases||[]).length, "| vale:", (s as any).vale_pass);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
