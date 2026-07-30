/**
 * Jamie Matkowski (ticket a00b0c22) — GATED Mixed Berry exchange, to run once MB restocks (~2026-07-29).
 *
 * Jamie got Strawberry Lemonade instead of Mixed Berry (crisis OOS swap) on two orders. Per CEO
 * ruling it's an EXCHANGE: her return (0eaf2e2f) is set to $0 refund, and we ship 6 Mixed Berry
 * tabs at no charge once MB is actually back. We deliberately did NOT create the order at ticket
 * time — while the crisis is active, ANY Mixed Berry order auto-swaps to Strawberry Lemonade again.
 *
 * ── THE HARD GATE ──
 * This script REFUSES to create the order while the Mixed Berry crisis (crisis_events row for
 * variant 42614433448109) is still status='active'. That single check makes it impossible to
 * re-ship Strawberry Lemonade: no order is created until MB is genuinely restocked (crisis resolved).
 *
 * Run on/after 2026-07-30:  npx tsx scripts/_jamie-mb-exchange.ts --apply
 * Dry-run (default) prints the gate result + planned order without mutating.
 * Idempotent: a marker note on the ticket prevents a second exchange order.
 */
import { createAdminClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TID = "a00b0c22-243c-489f-9b51-3d36533d34b8";
const CUSTOMER_ID = "a6c66a58-da18-4d37-b37f-0574097476fd";
const MB_VARIANT = "42614433448109"; // Superfood Tabs — Mixed Berry
const QTY = 6; // 3 from SC134066 + 3 from SC134070
const ADDRESS_ORDER = "SC134066";
const MARKER = "[mb-exchange-shipped]";

const RESPONSE_MESSAGE = `Great news, Jamie — Mixed Berry is back in stock, and your six Mixed Berry Superfood Tabs are on their way to you now at no charge.

Thanks so much for your patience, and sorry again for the mix-up.

Warm regards,
Suzie
Customer Care · Superfoods Company`;

async function main() {
  const admin = createAdminClient();

  // ── Idempotency: already shipped? ──
  const { data: prior } = await admin.from("ticket_messages").select("id").eq("ticket_id", TID).ilike("body", `${MARKER}%`).limit(1);
  if (prior && prior.length) { console.log("Already shipped (marker present) — no-op."); return; }

  // ── THE HARD GATE: MB crisis must be resolved ──
  const { data: crisis } = await admin.from("crisis_events")
    .select("id, status, affected_product_title, expected_restock_date")
    .eq("workspace_id", WS).eq("affected_variant_id", MB_VARIANT)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const crisisActive = crisis?.status === "active";
  console.log(`MB crisis: status=${crisis?.status ?? "(none)"} restock=${crisis?.expected_restock_date ?? "—"} → active=${crisisActive}`);
  if (crisisActive) {
    console.log("GATE CLOSED — Mixed Berry is still OOS (crisis active). Creating the order now would auto-swap to Strawberry Lemonade. REFUSING. Try again after restock.");
    return;
  }

  const decision = {
    reasoning: "Gated MB exchange: crisis resolved, shipping 6 Mixed Berry tabs free to Jamie (return already set to $0 refund).",
    action_type: "direct_action" as const,
    confidence: 0.97,
    actions: [
      { type: "create_replacement_order", order_number: ADDRESS_ORDER, items: [{ variant_id: MB_VARIANT, quantity: QTY }] },
    ],
    response_message: RESPONSE_MESSAGE,
  };

  if (!APPLY) {
    console.log("\n=== GATE OPEN (MB restocked) — dry-run, would execute ===");
    console.log(JSON.stringify(decision, null, 2));
    console.log("Re-run with --apply to ship + notify + close.");
    return;
  }

  const { executeSonnetDecision } = await import("../src/lib/action-executor");
  const { deliverTicketMessage } = await import("../src/lib/ticket-delivery");
  const { closeTicket } = await import("../src/lib/tickets-mutate");

  const sendFn = async (msg: string, sb: boolean) => { await deliverTicketMessage(admin, WS, TID, "portal", msg, sb); };
  const sysNoteFn = async (note: string) => { await admin.from("ticket_messages").insert({ ticket_id: TID, direction: "outbound", visibility: "internal", author_type: "system", body: note }); };

  const ctx = { admin, workspaceId: WS, ticketId: TID, customerId: CUSTOMER_ID, channel: "portal", sandbox: false };
  const result = await executeSonnetDecision(ctx as never, decision as never, null, sendFn, sysNoteFn);
  console.log("result:", JSON.stringify(result));
  if (result.escalated) { console.log("Order did not land (escalated) — NOT marking shipped."); return; }

  await sysNoteFn(`${MARKER} Shipped ${QTY}x Mixed Berry free exchange to Jamie after MB restock. Ticket resolved.`);
  await closeTicket(admin, TID, { reason: "Mixed Berry exchange shipped" });
  console.log("Exchange shipped + ticket closed.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
