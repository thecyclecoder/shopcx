/**
 * Shadow-measure: retire skip_next_order → alias to change_next_date / bill_now.
 *
 * The goal calls out an 88% failure rate on skip_next_order (dead Appstle endpoint).
 * Before retiring the action-type from the orchestrator, shadow-measure what the
 * orchestrator WOULD have emitted if the action catalog excluded skip_next_order
 * and carried a routing rule: "for a customer asking to skip the next order, emit
 * change_next_date with the next-next-scheduled-date, OR bill_now if they said
 * today/asap." Read-only: no writes, no orchestrator DB rules changed. Prints a
 * per-workspace report so we can compare shadow_success_rate vs historical.
 *
 *   Historical source: appstle_api_calls WHERE action_type='skip_next_order'
 *     — every real skip_next_order attempt of the last 30d, with its .success
 *     column giving the ~12% baseline success rate the spec cites.
 *
 *   Shadow: for each historical attempt, pull the inbound customer message
 *     that triggered the decision and re-classify via Anthropic with
 *     skip_next_order REMOVED from the action catalog + the routing rule
 *     prepended. The shadow's picked action_type is treated as "would have
 *     succeeded" when it lands on change_next_date or bill_now (a viable
 *     alias), and "would not have succeeded" when it lands on escalate.
 *
 * Run:  npx tsx scripts/_shadow-retire-skip-next-order.ts
 *       npx tsx scripts/_shadow-retire-skip-next-order.ts --days 30 --limit 50
 *
 * Read-only; NO mutation.
 */
import { createAdminClient } from "./_bootstrap";
import { SONNET_MODEL } from "../src/lib/ai-models";

type ShadowAction = "change_next_date" | "bill_now" | "escalate" | "other";

interface HistoricalAttempt {
  ticket_id: string;
  workspace_id: string;
  customer_id: string | null;
  created_at: string;
  success: boolean;
  error_summary: string | null;
}

interface ShadowRow {
  ticket_id: string;
  workspace_id: string;
  workspace_name: string;
  historical_success: boolean;
  inbound_snippet: string;
  shadow_action: ShadowAction;
  shadow_reasoning: string;
}

function parseArgs(): { days: number; limit: number | null } {
  const args = process.argv.slice(2);
  let days = 30;
  let limit: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) days = Number(args[++i]);
    else if (args[i] === "--limit" && args[i + 1]) limit = Number(args[++i]);
  }
  return { days, limit };
}

function truncate(s: string, n: number): string {
  const t = s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

const SHADOW_SYSTEM = `You are a classifier deciding which subscription action a customer support message should route to. skip_next_order is RETIRED (dead endpoint, 88% failure rate) and has been REMOVED from the action catalog.

ROUTING RULE (hard override): For a customer asking to skip the next order, emit change_next_date with the next-next-scheduled-date, OR bill_now if they said today/asap.

ACTION CATALOG:
- change_next_date — push the next scheduled ship date to a future date (typically ~30 days out — i.e. the next-next-scheduled-date). Use when the customer wants their next box LATER ("push it to next month", "skip the next one", "not ready yet", "delay").
- bill_now — charge the current upcoming order right away. Use when the customer wants their next box NOW ("send today", "asap", "ship it now", "I'm out").
- escalate — the message is not actually a skip request, or you cannot tell without more data.
- other — the customer's intent is a different subscription action (pause, cancel, change_frequency, remove_item, etc.).

Respond with ONLY a single JSON object, no prose:
{"action_type":"change_next_date"|"bill_now"|"escalate"|"other","reasoning":"one short sentence"}`;

async function classifyOne(
  apiKey: string,
  inbound: string,
): Promise<{ action_type: ShadowAction; reasoning: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: 200,
      system: SHADOW_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Customer message:\n"${inbound.slice(0, 2000)}"\n\nClassify.`,
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text: string = (data.content || []).map((b: { type: string; text?: string }) => b.text || "").join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { action_type: "other", reasoning: `parse-fail: ${text.slice(0, 120)}` };
  try {
    const parsed = JSON.parse(match[0]) as { action_type?: string; reasoning?: string };
    const at = parsed.action_type as ShadowAction | undefined;
    if (at === "change_next_date" || at === "bill_now" || at === "escalate" || at === "other") {
      return { action_type: at, reasoning: (parsed.reasoning || "").slice(0, 300) };
    }
    return { action_type: "other", reasoning: `unknown action_type: ${parsed.action_type}` };
  } catch {
    return { action_type: "other", reasoning: `json-parse-fail: ${text.slice(0, 120)}` };
  }
}

async function main() {
  const { days, limit } = parseArgs();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  const admin = createAdminClient();
  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();

  console.log(`\n─── Shadow-measure: retire skip_next_order ───`);
  console.log(`Window: last ${days} days (since ${sinceIso})`);
  console.log(`Fetching historical skip_next_order attempts…\n`);

  const { data: attempts, error } = await admin
    .from("appstle_api_calls")
    .select("ticket_id, workspace_id, customer_id, created_at, success, error_summary")
    .eq("action_type", "skip_next_order")
    .gte("created_at", sinceIso)
    .not("ticket_id", "is", null)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  const rows = ((attempts || []) as HistoricalAttempt[]).filter((r) => r.ticket_id);
  if (!rows.length) {
    console.log("No historical skip_next_order attempts in window. Nothing to shadow.");
    return;
  }

  // Dedupe by ticket_id — one shadow decision per ticket, using the earliest
  // attempt's success as the ground-truth outcome for the historical decision.
  const byTicket = new Map<string, HistoricalAttempt>();
  for (const r of rows) {
    const cur = byTicket.get(r.ticket_id);
    if (!cur || r.created_at < cur.created_at) byTicket.set(r.ticket_id, r);
  }
  let ticketAttempts = Array.from(byTicket.values());
  if (limit && limit > 0) ticketAttempts = ticketAttempts.slice(0, limit);

  console.log(`Historical attempts:  ${rows.length}`);
  console.log(`Unique tickets:       ${byTicket.size}`);
  console.log(`Shadowing:            ${ticketAttempts.length}${limit ? ` (--limit ${limit})` : ""}\n`);

  // Preload workspace names.
  const wsIds = Array.from(new Set(ticketAttempts.map((r) => r.workspace_id)));
  const { data: workspaces } = await admin.from("workspaces").select("id, name").in("id", wsIds);
  const wsName = new Map<string, string>();
  for (const w of workspaces || []) wsName.set(w.id, (w.name as string) || w.id);

  const shadows: ShadowRow[] = [];

  for (let i = 0; i < ticketAttempts.length; i++) {
    const att = ticketAttempts[i];
    // Fetch the first inbound customer message on this ticket BEFORE the
    // historical skip_next_order attempt — that's the message that would
    // have driven the orchestrator's decision.
    const { data: msgs } = await admin
      .from("ticket_messages")
      .select("body, body_clean, direction, author_type, created_at")
      .eq("ticket_id", att.ticket_id)
      .eq("direction", "inbound")
      .lte("created_at", att.created_at)
      .order("created_at", { ascending: false })
      .limit(1);
    const m = (msgs || [])[0] as { body?: string; body_clean?: string } | undefined;
    const inbound = truncate((m?.body_clean || m?.body || "").toString(), 2000);
    if (!inbound) {
      // Rare — historical attempt with no inbound message row (portal-form
      // originated with body-only in a different column shape, or the row
      // was deleted). Skip; can't shadow-classify what we can't see.
      continue;
    }

    let shadow: { action_type: ShadowAction; reasoning: string };
    try {
      shadow = await classifyOne(apiKey, inbound);
    } catch (err) {
      shadow = {
        action_type: "other",
        reasoning: `error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    shadows.push({
      ticket_id: att.ticket_id,
      workspace_id: att.workspace_id,
      workspace_name: wsName.get(att.workspace_id) || att.workspace_id,
      historical_success: !!att.success,
      inbound_snippet: truncate(inbound, 140),
      shadow_action: shadow.action_type,
      shadow_reasoning: shadow.reasoning,
    });

    if ((i + 1) % 10 === 0) {
      process.stdout.write(`  … shadowed ${i + 1}/${ticketAttempts.length}\n`);
    }
  }

  // Aggregate per workspace.
  const byWs = new Map<string, ShadowRow[]>();
  for (const s of shadows) {
    if (!byWs.has(s.workspace_id)) byWs.set(s.workspace_id, []);
    byWs.get(s.workspace_id)!.push(s);
  }

  console.log(`\n═══ Per-workspace report ═══`);
  for (const [wsId, wsRows] of byWs) {
    const total = wsRows.length;
    const historicalSuccess = wsRows.filter((r) => r.historical_success).length;
    const shadowSuccess = wsRows.filter(
      (r) => r.shadow_action === "change_next_date" || r.shadow_action === "bill_now",
    ).length;
    const shifted = wsRows.filter(
      (r) => r.shadow_action !== "escalate" && r.shadow_action !== "other",
    ).length;
    const billNow = wsRows.filter((r) => r.shadow_action === "bill_now").length;
    const changeDate = wsRows.filter((r) => r.shadow_action === "change_next_date").length;
    const escalate = wsRows.filter((r) => r.shadow_action === "escalate").length;
    const other = wsRows.filter((r) => r.shadow_action === "other").length;

    const pct = (n: number) => (total > 0 ? ((n / total) * 100).toFixed(1) + "%" : "—");

    console.log(`\nWorkspace: ${wsName.get(wsId) || wsId}   (${wsId})`);
    console.log(`  historical attempts (shadowed):  ${total}`);
    console.log(`  historical_success_rate:         ${pct(historicalSuccess)}   (${historicalSuccess}/${total})`);
    console.log(`  shadow_success_rate:             ${pct(shadowSuccess)}   (${shadowSuccess}/${total})   ← change_next_date + bill_now`);
    console.log(`  avg_action_shift:                ${pct(shifted)}   (rows moved off skip_next_order)`);
    console.log(`  shadow breakdown:                change_next_date=${changeDate}  bill_now=${billNow}  escalate=${escalate}  other=${other}`);

    const samples = wsRows.slice(0, 5);
    console.log(`  sample tickets:`);
    for (const s of samples) {
      console.log(`    ${s.ticket_id}  [${s.shadow_action}]  “${s.inbound_snippet}”`);
    }
  }

  // Overall
  const total = shadows.length;
  const shadowSuccess = shadows.filter(
    (r) => r.shadow_action === "change_next_date" || r.shadow_action === "bill_now",
  ).length;
  const historicalSuccess = shadows.filter((r) => r.historical_success).length;
  const pct = (n: number) => (total > 0 ? ((n / total) * 100).toFixed(1) + "%" : "—");
  console.log(`\n═══ Overall ═══`);
  console.log(`  tickets shadowed:            ${total}`);
  console.log(`  historical_success_rate:     ${pct(historicalSuccess)}`);
  console.log(`  shadow_success_rate:         ${pct(shadowSuccess)}`);
  console.log(`\nDone.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
