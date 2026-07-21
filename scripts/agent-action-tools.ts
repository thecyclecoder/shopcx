/**
 * agent-action-tools — Sol's WRITE-side box tools: her only mutation path from a read-only session.
 * She ENQUEUES a validated SonnetDecision (the execute-worker runs it) and POLLS for the verified
 * result. The decision is schema-checked here (trusted CLI, not the LLM) before it ever lands.
 *
 * Usage (from the ticket-handle skill):
 *   npx tsx scripts/agent-action-tools.ts enqueue <ticket_id> ['<decision_json>' | -]  [--condition '<json>'] [--expires <iso>]
 *   npx tsx scripts/agent-action-tools.ts poll    <request_id> [--timeout-ms 20000]
 *
 * DRY RUN is forced by the session, not by Sol: if SOL_DRY_RUN=1 is in the environment (the worker
 * sets it when launching a rehearsal), every enqueue is dry_run — Sol cannot turn it off. A `--dry-run`
 * flag can turn it ON for a single call, but never OFF a session-level rehearsal.
 *
 * See src/lib/agent-action-queue.ts + the agent_action_requests migration.
 */
import { readFileSync, existsSync } from "fs";
import { errText } from "../src/lib/error-text";
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

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function readDecisionArg(arg: string | undefined): Record<string, unknown> {
  const raw = !arg || arg === "-" ? readFileSync(0, "utf8") : arg; // '-' or omitted → stdin
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`decision must be valid JSON: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
}

async function main() {
  const [, , cmd] = process.argv;
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  if (cmd === "enqueue") {
    const ticketId = process.argv[3];
    if (!ticketId) { console.error("usage: enqueue <ticket_id> ['<decision_json>' | -]"); process.exit(2); }
    const decision = readDecisionArg(process.argv[4]);

    const { data: ticket } = await admin.from("tickets")
      .select("workspace_id, customer_id").eq("id", ticketId).single();
    if (!ticket?.workspace_id) { console.error(`ticket ${ticketId} not found`); process.exit(1); }

    // Live Direction (best-effort) for provenance on the request row.
    let directionId: string | null = null;
    try {
      const { loadLiveDirection } = await import("../src/lib/ticket-directions");
      const dir = await loadLiveDirection(admin, ticketId, { workspace_id: ticket.workspace_id as string });
      directionId = dir?.id ?? null;
    } catch { /* provenance is optional */ }

    const dryRun = process.env.SOL_DRY_RUN === "1" || hasFlag("dry-run");
    const conditionJson = flag("condition");
    const triggerCondition = conditionJson ? JSON.parse(conditionJson) : null;

    const { enqueueActionRequest } = await import("../src/lib/agent-action-queue");
    const res = await enqueueActionRequest(admin, {
      workspaceId: ticket.workspace_id as string,
      ticketId,
      customerId: (ticket.customer_id as string | null) ?? null,
      directionId,
      decision,
      dryRun,
      triggerCondition,
      expiresAt: flag("expires") ?? null,
    });
    if (!res.ok) { console.error(`enqueue rejected: ${res.error}`); process.exit(1); }
    console.log(JSON.stringify({ request_id: res.id, status: res.status, dry_run: dryRun }));
    return;
  }

  if (cmd === "poll") {
    const requestId = process.argv[3];
    if (!requestId) { console.error("usage: poll <request_id> [--timeout-ms 20000]"); process.exit(2); }
    const timeoutMs = Number(flag("timeout-ms") || 20000);
    const { waitForTerminal } = await import("../src/lib/agent-action-queue");
    const req = await waitForTerminal(admin, requestId, { timeoutMs });
    if (!req) { console.error(`request ${requestId} not found`); process.exit(1); }
    console.log(JSON.stringify({
      request_id: req.id, status: req.status, dry_run: req.dry_run,
      result: req.result, error: req.error,
    }));
    return;
  }

  console.error("usage: agent-action-tools.ts <enqueue|poll> ...");
  process.exit(2);
}

main().catch((e) => { console.error(errText(e)); process.exit(1); });
