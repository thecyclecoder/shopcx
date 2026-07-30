import { createAdminClient } from "./_bootstrap";
import { applySolLinkProposal } from "../src/lib/sol-link-proposal";
import { linkGroupIds } from "../src/lib/customer-links";

const WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET = "54f0f29e-d3f0-4f2e-9b85-114170dc075b";
const TICKET_CUSTOMER = "98f54a3e-a256-4b98-843a-d0e5a27c5a51"; // metz.julie323@gmail.com (empty)
const CANDIDATES = [
  { id: "1b11a298-0182-4246-95b7-41c64922ca5c", label: "julie.metz@hotmail.com (Tabs, 8 orders)" },
  { id: "8456e025-9b8f-4c9c-a473-e219a6df3912", label: "metzjulie323@gmail.com (Coffee/Creamer)" },
];

async function main() {
  const admin = createAdminClient();
  const apply = process.argv.includes("--apply");

  for (const cand of CANDIDATES) {
    console.log(`\n--- link ${TICKET_CUSTOMER}  <->  ${cand.id}  [${cand.label}] ---`);
    if (!apply) { console.log("(dry run)"); continue; }
    const res = await applySolLinkProposal(admin, {
      workspaceId: WORKSPACE,
      ticketId: TICKET,
      ticketCustomerId: TICKET_CUSTOMER,
      proposal: {
        candidate_customer_id: cand.id,
        confidence: "high",
        signals: ["address", "name", "email"],
        reason:
          "Same person: identical address 6225 Hwy 45se, Gackle ND 58442; same name Julie Metz; ticket email metz.julie323@gmail.com is the Gmail dot-variant of metzjulie323@gmail.com. Verified by CS.",
      },
    });
    console.log(JSON.stringify(res));
  }

  console.log("\n=== resulting link group for ticket customer ===");
  const group = await linkGroupIds(admin, WORKSPACE, TICKET_CUSTOMER);
  console.log(group);
  for (const id of group) {
    const { data: c } = await admin.from("customers").select("id, email, total_orders, subscription_status").eq("id", id).maybeSingle();
    console.log("  ", JSON.stringify(c));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
