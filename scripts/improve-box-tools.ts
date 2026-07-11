/**
 * improve-box-tools — the read-only investigation tools for the box Improve agent
 * (box-ticket-improve). The box's Max `claude -p` session has no prod creds of its own; it reaches
 * the prod DB READ-ONLY through this deterministic CLI, which wraps the SAME data tools the old
 * Improve route exposed (delegating to sonnet-orchestrator-v2's shared executor). It NEVER mutates —
 * mutation only happens server-side after the founder approves the proposed plan.
 *
 * Usage (from the box skill):
 *   npx tsx scripts/improve-box-tools.ts <tool> <ticket_id> [json_input]
 *
 * Tools: get_customer_account · get_product_knowledge · get_product_nutrition · get_returns ·
 *        get_chargebacks · get_email_history · get_crisis_status · get_dunning_status · get_ticket_analysis
 *
 * Prints the tool's text result to stdout. See docs/brain/specs/box-ticket-improve.md.
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}

const READ_TOOLS = new Set([
  "get_customer_account",
  "get_product_knowledge",
  "get_product_nutrition",
  "get_returns",
  "get_chargebacks",
  "get_email_history",
  "get_crisis_status",
  "get_dunning_status",
  "get_ticket_analysis",
  // Phase 1 of sol-reviews-policies-and-never-bais-an-out-of-policy-outcome:
  // active-policy lookup so Sol can confirm what is allowed BEFORE proposing an
  // outcome (returns / refunds / consumable / subscription returnability /
  // exception ceilings). Read-only against `public.policies` (is_active,
  // superseded_by IS NULL). Optional json_input `{"slug":"<slug>"}` narrows to
  // one policy; the argless form lists every active policy for the workspace.
  "get_policies",
  // Account linking is FUNDAMENTAL to ticket handling. get_link_candidates surfaces graded unlinked
  // siblings (address/phone-corroborated = high) so Sol/June catch a same-person second account before
  // concluding "no such account/charge"; search_orders reconciles a disputed "$X on <date>" charge
  // across EVERY customer (it may live on an unlinked sibling). Both read-only. Ticket db8b3d66.
  "get_link_candidates",
  "search_orders",
]);

async function main() {
  const [, , tool, ticketId, inputJson] = process.argv;
  if (!tool || !ticketId) {
    console.error("usage: improve-box-tools.ts <tool> <ticket_id> [json_input]");
    process.exit(2);
  }
  if (!READ_TOOLS.has(tool)) {
    console.error(`refused: '${tool}' is not a read-only investigation tool. Allowed: ${[...READ_TOOLS].join(", ")}`);
    process.exit(2);
  }
  let input: Record<string, unknown> = {};
  if (inputJson) {
    try {
      input = JSON.parse(inputJson);
    } catch {
      console.error("input must be valid JSON");
      process.exit(2);
    }
  }

  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, workspace_id, customer_id")
    .eq("id", ticketId)
    .single();
  if (!ticket) {
    console.error(`ticket ${ticketId} not found`);
    process.exit(1);
  }

  const { default: executeToolCallImprove } = await import("../src/lib/improve-tools");
  const result = await executeToolCallImprove(tool, input, ticket.workspace_id, { id: ticket.id });
  process.stdout.write(typeof result === "string" ? result : JSON.stringify(result));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
