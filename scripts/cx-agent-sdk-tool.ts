/**
 * cx-agent-sdk-tool — the box-side READ-ONLY CLI wrapper the three CX box agents
 * (Sol / Cora / June) invoke instead of authoring raw SQL for customer + merged
 * identity, orders w/ line items, subscriptions, products, or active policies.
 * Phase 1 of docs/brain/specs/cx-box-agents-sol-cora-june-deterministic-sdk-
 * toolset-and-brain-access-no-raw-sql.md.
 *
 * Usage (from any of the three CX box skills):
 *   npx tsx scripts/cx-agent-sdk-tool.ts <verb> <ticket_id>
 *
 * Verbs: customer · orders · subscriptions · products · policies · bundle
 *
 * Prints the SDK's formatted text output to stdout. NEVER mutates. The three
 * agents' verdicts flow back through the deterministic worker path (writeDirection
 * for Sol, applyAnalyzerVerdict for Cora, executeSonnetDecision / spec author for
 * June). See src/lib/cx-agent-sdk.ts for the underlying getters.
 */
import { readFileSync, existsSync } from "fs";
import { errText } from "../src/lib/error-text";
import { resolve } from "path";

// Bootstrap env from .env.local when present (the box worker unsets ANTHROPIC_API_KEY
// but keeps the Supabase creds so read-only DB tools work). Same shape as
// scripts/improve-box-tools.ts / scripts/analyzer-research-tools.ts.
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

async function main() {
  const [, , verb, ticketId] = process.argv;
  const {
    CX_SDK_VERBS,
    isCxSdkVerb,
    runCxSdkVerb,
    isValidCxTicketId,
    invalidCxTicketIdMessage,
  } = await import("../src/lib/cx-agent-sdk");
  if (!verb || !ticketId) {
    console.error(
      `usage: cx-agent-sdk-tool.ts <verb> <ticket_id>\nverbs: ${CX_SDK_VERBS.join(" · ")}`,
    );
    process.exit(2);
  }
  if (!isCxSdkVerb(verb)) {
    console.error(
      `refused: '${verb}' is not a cx-agent-sdk verb. Allowed: ${CX_SDK_VERBS.join(", ")}`,
    );
    process.exit(2);
  }
  // UUID-guard the id BEFORE hitting Postgres — a malformed id (8-hex
  // '3cc11e10' incident) would otherwise raise 22P02 and crash the tool call.
  // Give the agent a clean, self-correcting message + a non-crash exit code.
  if (!isValidCxTicketId(ticketId)) {
    console.error(invalidCxTicketIdMessage(ticketId));
    process.exit(2);
  }

  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, workspace_id, customer_id")
    .eq("id", ticketId)
    .maybeSingle();
  if (!ticket) {
    console.error(`ticket ${ticketId} not found`);
    process.exit(1);
  }
  const result = await runCxSdkVerb(
    admin,
    verb,
    ticket.workspace_id as string,
    (ticket.customer_id as string | null) ?? null,
  );
  process.stdout.write(result);
}

main().catch((e) => {
  console.error(errText(e));
  process.exit(1);
});
