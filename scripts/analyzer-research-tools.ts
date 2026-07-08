/**
 * analyzer-research-tools — bounded READ-ONLY research tools for the box's ticket-analyze
 * agent (Cora). Phase 1 of docs/brain/specs/cora-gets-readonly-research-power-to-verify-claims-before-grading.md.
 *
 * Cora grades the AI's conversation window against the QC rubric. Previously she could only
 * grade what the transcript showed — a claim she couldn't confirm from the transcript became
 * a guess. This CLI gives her a HANDFUL of targeted read-only lookups so she can verify a
 * claim (a variant/flavor, an actual per-unit charged amount, a subscription state, a
 * customer profile fact) BEFORE grading it. Brain/policy read still happens directly via
 * Claude Code's Read/Grep against docs/brain/.
 *
 * Deliberately BOUNDED — a handful of targeted lookups per grade, not open-ended. The tools
 * delegate to sonnet-orchestrator-v2's executeToolCall (the same shared read-only executor
 * the improve/handle agents use), so the shape stays consistent and there's ONE place that
 * knows how to render each data view.
 *
 * NEVER mutates. The analyzer's ONLY write is its verdict, and that flows back through
 * applyAnalyzerVerdict on the deterministic worker — not from this CLI.
 *
 * Usage (from the ticket-analyze skill):
 *   npx tsx scripts/analyzer-research-tools.ts <tool> <ticket_id> [json_input]
 *
 * Tools: get_customer_account · get_product_knowledge · get_product_nutrition · get_returns ·
 *        get_ticket_analysis
 *
 * Prints the tool's text result to stdout. See docs/brain/specs/cora-gets-readonly-research-power-to-verify-claims-before-grading.md.
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

// The bounded allowlist. Deliberately narrower than the improve-tools set — Cora's job is
// to VERIFY a specific transcript claim, not to open-endedly investigate the whole account.
// Covers the exact surfaces the spec names: product (variants/flavors/pricing) · order +
// line-item (actual charged amounts, via get_customer_account's orders block) · subscription
// + customer (get_customer_account) · latest analysis (get_ticket_analysis). Brain/policy
// read happens via Claude Code's native Read/Grep against docs/brain/, not here.
const READ_TOOLS = new Set([
  "get_customer_account",
  "get_product_knowledge",
  "get_product_nutrition",
  "get_returns",
  "get_ticket_analysis",
]);

async function main() {
  const [, , tool, ticketId, inputJson] = process.argv;
  if (!tool || !ticketId) {
    console.error("usage: analyzer-research-tools.ts <tool> <ticket_id> [json_input]");
    process.exit(2);
  }
  if (!READ_TOOLS.has(tool)) {
    console.error(`refused: '${tool}' is not an analyzer read-only research tool. Allowed: ${[...READ_TOOLS].join(", ")}`);
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

  // Delegate to the shared read-only tool executor — same code path improve/handle/orchestrator
  // use. Preserves the linked-account expansion (resolveLinkedCustomerIds) so a claim on a
  // sibling profile is still visible, and preserves the per-line pricing block that lets Cora
  // compare the AI's per-unit claim to the ACTUAL charged amounts.
  const { default: executeToolCallImprove } = await import("../src/lib/improve-tools");
  const result = await executeToolCallImprove(tool, input, ticket.workspace_id, { id: ticket.id });
  process.stdout.write(typeof result === "string" ? result : JSON.stringify(result));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
