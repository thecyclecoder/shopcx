import { createAdminClient } from "./_bootstrap";
import { sendThreadedReply } from "../src/lib/tickets-reply";

const MELISSA_TICKET = "eca3f43b-a59d-4081-8a40-be84e6e4ada7";
const WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const LABEL_URL =
  "https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260713/e80a49909eaba64890974cd6747723f7d4.png";

const message = [
  `Hi Melissa, good news — your refund is authorized and ready to go.`,
  `Just send your two Superfood Tabs back with the prepaid return label we sent you, and the full $116.96 will be refunded as soon as the package reaches us.`,
  `The label is fully prepaid, so there's nothing deducted on your end — you won't pay the $4.95 or any shipping.`,
  `Here's the label again so it's one click: ${LABEL_URL}`,
  `Thanks for your patience, Melissa.`,
].join("\n\n");

async function main() {
  const admin = createAdminClient();

  const apply = process.argv.includes("--apply");
  console.log("=== reply to send ===\n" + message + "\n");

  if (apply) {
    const res = await sendThreadedReply(admin, {
      workspaceId: WORKSPACE,
      ticketId: MELISSA_TICKET,
      message,
    });
    console.log("=== send result ===", JSON.stringify(res, null, 2));
  } else {
    console.log("(dry run — pass --apply to send)");
  }

  // Julie broader locate — orders shipping to ND / Gackle
  console.log("\n=== Julie: orders shipping to ND / Gackle ===");
  const { data: nd } = await admin
    .from("orders")
    .select("id, order_number, customer_id, email, shipping_address, total_price, created_at")
    .or("shipping_address->>province.ilike.%north dakota%,shipping_address->>provinceCode.eq.ND,shipping_address->>city.ilike.%gackle%")
    .limit(40);
  for (const o of nd || []) {
    const a = (o as any).shipping_address || {};
    console.log(JSON.stringify({ order: o.order_number, email: o.email, name: `${a.firstName || a.first_name || ""} ${a.lastName || a.last_name || ""}`, city: a.city, prov: a.province || a.provinceCode, addr: a.address1, created: o.created_at }));
  }

  // Any customer whose email starts metz / contains julie323
  console.log("\n=== Julie: customers email like metz / julie323 ===");
  const { data: cm } = await admin
    .from("customers")
    .select("id, email, first_name, last_name, phone")
    .or("email.ilike.%metz%,email.ilike.%julie323%")
    .limit(20);
  for (const c of cm || []) console.log(JSON.stringify(c));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
