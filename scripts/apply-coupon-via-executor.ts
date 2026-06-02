/**
 * Run apply_coupon through executeSonnetDecision — same code path
 * production uses, no freestyle.
 *
 * Usage:
 *   npx tsx scripts/apply-coupon-via-executor.ts sherri
 *   npx tsx scripts/apply-coupon-via-executor.ts sherri --apply
 *   npx tsx scripts/apply-coupon-via-executor.ts jennifer --apply
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
const which = process.argv[2];

const CASES: Record<string, {
  ticketId: string;
  customerId: string;
  contractId: string;
  code: string;
  channel: string;
  responseTemplate: string; // what we'll tell the customer
  description: string;
}> = {
  sherri: {
    ticketId: "981bf7c0-6d18-4f54-91aa-20862dc8e0ec",
    customerId: "21f10892-da93-473a-8be9-79ccc8cbea2c",
    contractId: "27844051117",
    code: "OOSMB-4926",
    channel: "chat",
    responseTemplate: `Quick follow-up — I've now applied the 20% off coupon (${"OOSMB-4926"}) to your subscription. It'll come off your next renewal automatically. Sorry again for the Mixed Berry mixup — Peach Mango is on its way.`,
    description: "Crisis 20% coupon (OOSMB-4926) on Sherri's contract 27844051117",
  },
  jennifer: {
    ticketId: "6123836f-51d2-42dc-8d92-dc89edfc3795",
    customerId: "36bb5ad6-9e82-4c9e-8a9c-2d898445f60e",
    contractId: "27828322477",
    code: "LOYALTY-15-8JJ66Z",
    channel: "chat",
    responseTemplate: `All set — your $15 loyalty coupon (LOYALTY-15-8JJ66Z) has been applied to your subscription. It'll come off your next renewal on May 1st. Your other $15 coupon stays on your account for a future renewal or one-time order.`,
    description: "Loyalty $15 coupon (LOYALTY-15-8JJ66Z) on Jennifer's contract 27828322477",
  },
};

const c = CASES[which];
if (!c) {
  console.error(`Usage: npx tsx scripts/apply-coupon-via-executor.ts <sherri|jennifer> [--apply]`);
  process.exit(1);
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");
  console.log(`Case: ${c.description}`);

  // Pre-flight: confirm sub still active and no existing discount that would block apply
  const { data: sub } = await admin
    .from("subscriptions")
    .select("status, applied_discounts")
    .eq("workspace_id", W)
    .eq("shopify_contract_id", c.contractId)
    .single();
  console.log(`\nSub: status=${sub?.status}, existing discounts=${JSON.stringify(sub?.applied_discounts)}`);
  if (sub?.status !== "active") {
    console.log("  ⚠ Sub not active — aborting");
    process.exit(1);
  }

  if (!APPLY) {
    console.log("\nWould run executeSonnetDecision with:");
    console.log("  action_type: direct_action");
    console.log(`  actions: [{ type: 'apply_coupon', contract_id: '${c.contractId}', code: '${c.code}' }]`);
    console.log(`  response_message: ${c.responseTemplate.slice(0, 100)}...`);
    console.log("\nRe-run with --apply to execute");
    return;
  }

  // Build SonnetDecision and run via the standard executor
  const { executeSonnetDecision } = await import("../src/lib/action-executor");
  const { sendTicketReply } = await import("../src/lib/email");

  const decision = {
    reasoning: `Operator-triggered re-attempt of apply_coupon after the original Sonnet run hit Appstle 400. ${c.description}`,
    action_type: "direct_action" as const,
    actions: [{ type: "apply_coupon", contract_id: c.contractId, code: c.code }],
    response_message: c.responseTemplate,
  };

  // For chat tickets, executeSonnetDecision expects a SendFn that posts
  // via the chat widget. For an operator re-run we want the message to
  // land in the ticket as an outbound 'ai' message — we'll insert it
  // ourselves and use a no-op SendFn so the executor still gets
  // messageSent=true for its tracking.
  let actuallySent = false;

  const sendFn = async (msg: string, _sandbox: boolean) => {
    actuallySent = true;
    // For operator re-runs we want this in the ticket history.
    // Chat tickets just need a ticket_messages row — the widget polls.
    await admin.from("ticket_messages").insert({
      ticket_id: c.ticketId,
      direction: "outbound",
      visibility: "external",
      author_type: "ai",
      body: msg,
      sent_at: new Date().toISOString(),
    });
    console.log(`  ✓ ticket_messages row inserted (chat customer will see on next poll)`);
  };

  const sysNoteFn = async (msg: string) => {
    await admin.from("ticket_messages").insert({
      ticket_id: c.ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: msg,
    });
    console.log(`  · ${msg}`);
  };

  console.log("\n▶ Running executeSonnetDecision...");
  const result = await executeSonnetDecision(
    {
      admin,
      workspaceId: W,
      ticketId: c.ticketId,
      customerId: c.customerId,
      channel: c.channel,
      sandbox: false,
    },
    decision,
    null,
    sendFn,
    sysNoteFn,
  );

  console.log(`\nResult: messageSent=${result.messageSent}, escalated=${result.escalated}, sent=${actuallySent}`);

  // Verify outcome
  const { data: subAfter } = await admin
    .from("subscriptions")
    .select("applied_discounts, updated_at")
    .eq("workspace_id", W)
    .eq("shopify_contract_id", c.contractId)
    .single();
  console.log(`\nPost-apply discounts: ${JSON.stringify(subAfter?.applied_discounts)}`);

  if (result.escalated) {
    console.log("\n⚠ Coupon apply still failed (escalated). Ticket stays open for agent.");
  } else if (subAfter?.applied_discounts && (subAfter.applied_discounts as unknown[]).length > 0) {
    console.log("\n✅ Coupon applied successfully.");
  } else {
    console.log("\n? Coupon may have applied but didn't reflect in DB yet (webhook lag possible).");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
