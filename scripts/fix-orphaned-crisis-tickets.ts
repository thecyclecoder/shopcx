/**
 * Retroactive fix: merge orphaned crisis reply tickets back into original crisis tickets.
 *
 * Usage:
 *   npx tsx scripts/fix-orphaned-crisis-tickets.ts           # dry run (log only)
 *   npx tsx scripts/fix-orphaned-crisis-tickets.ts --execute  # live run
 *   npx tsx scripts/fix-orphaned-crisis-tickets.ts --execute --limit 1  # live, one ticket only
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://urjbhjbygyxffrfkarqn.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY;

if (!SUPABASE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY required. Run with: npx tsx -r dotenv/config scripts/fix-orphaned-crisis-tickets.ts");
  process.exit(1);
}

const isExecute = process.argv.includes("--execute");
const limitArg = process.argv.find(a => a.startsWith("--limit"));
const limit = limitArg ? parseInt(process.argv[process.argv.indexOf(limitArg) + 1] || "999", 10) : 999;

async function sb(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: opts.method || "GET",
    headers: {
      apikey: SUPABASE_KEY!,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: opts.method === "PATCH" || opts.method === "DELETE" ? "return=minimal" : "return=representation",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok && opts.method !== "PATCH") {
    const text = await res.text();
    throw new Error(`Supabase ${opts.method || "GET"} ${path}: ${res.status} ${text}`);
  }
  if (opts.method === "PATCH" || opts.method === "DELETE") return null;
  return res.json();
}

async function main() {
  console.log(`\n🔍 Finding orphaned crisis tickets... (mode: ${isExecute ? "EXECUTE" : "DRY RUN"})\n`);

  // Get all active crisis events
  const crises = await sb("crisis_events?status=eq.active&select=id,affected_product_title");
  if (!crises.length) {
    console.log("No active crises found.");
    return;
  }
  console.log(`Active crises: ${crises.map((c: { affected_product_title: string }) => c.affected_product_title).join(", ")}`);

  // Get all crisis_customer_actions with ticket_id (not exhausted)
  const actions = await sb("crisis_customer_actions?select=id,customer_id,ticket_id,crisis_id&exhausted_at=is.null&current_tier=gt.0");
  if (!actions.length) {
    console.log("No active crisis actions found.");
    return;
  }

  const crisisMap = new Map(crises.map((c: { id: string; affected_product_title: string }) => [c.id, c.affected_product_title]));
  const customerToCrisisTicket = new Map<string, { ticketId: string; crisisId: string }>();
  for (const a of actions) {
    if (a.ticket_id && a.customer_id) {
      customerToCrisisTicket.set(a.customer_id, { ticketId: a.ticket_id, crisisId: a.crisis_id });
    }
  }

  // Get open tickets
  const openTickets = await sb("tickets?status=eq.open&order=created_at.desc&select=id,subject,customer_id,workspace_id,channel");

  let merged = 0;
  for (const ticket of openTickets) {
    if (merged >= limit) break;

    const crisisInfo = customerToCrisisTicket.get(ticket.customer_id);
    if (!crisisInfo) continue; // Customer has no crisis action
    if (ticket.id === crisisInfo.ticketId) continue; // This IS the crisis ticket

    // Subject match
    const productTitle = crisisMap.get(crisisInfo.crisisId);
    if (!productTitle) continue;
    const cleanSubject = (ticket.subject || "").replace(/^(Re:|Fwd?:|Fw:)\s*/gi, "").trim().toLowerCase();
    if (!cleanSubject.includes(productTitle.toLowerCase())) {
      console.log(`  SKIP ${ticket.id} — subject "${ticket.subject}" doesn't match "${productTitle}"`);
      continue;
    }

    console.log(`\n  MERGE ${ticket.id} → ${crisisInfo.ticketId}`);
    console.log(`    Subject: "${ticket.subject}"`);
    console.log(`    Customer: ${ticket.customer_id}`);

    // Get messages from orphan
    const messages = await sb(`ticket_messages?ticket_id=eq.${ticket.id}&direction=eq.inbound&author_type=eq.customer&order=created_at.asc&select=id,body,body_clean,created_at`);
    console.log(`    Inbound messages: ${messages.length}`);
    for (const m of messages) {
      const preview = (m.body_clean || m.body || "").slice(0, 80).replace(/\n/g, " ");
      console.log(`      - "${preview}..."`);
    }

    if (!isExecute) {
      console.log(`    [DRY RUN] Would merge ${messages.length} messages and close orphan`);
      merged++;
      continue;
    }

    // Move ALL messages (inbound + outbound) from orphan to crisis ticket
    await sb(`ticket_messages?ticket_id=eq.${ticket.id}`, {
      method: "PATCH",
      body: { ticket_id: crisisInfo.ticketId },
    });

    // System note on crisis ticket
    await sb("ticket_messages", {
      method: "POST",
      body: {
        ticket_id: crisisInfo.ticketId,
        direction: "outbound",
        visibility: "internal",
        author_type: "system",
        body: `[System] Merged ${messages.length} message(s) from orphaned ticket ${ticket.id}. Subject: "${ticket.subject}"`,
      },
    });

    // Close orphan
    await sb(`tickets?id=eq.${ticket.id}`, {
      method: "PATCH",
      body: { status: "closed", updated_at: new Date().toISOString() },
    });

    // Reopen crisis ticket
    await sb(`tickets?id=eq.${crisisInfo.ticketId}`, {
      method: "PATCH",
      body: { status: "open", closed_at: null, last_customer_reply_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    });

    // Fire unified handler with the latest customer message
    const latestMsg = messages[messages.length - 1];
    if (latestMsg && INNGEST_EVENT_KEY) {
      const inngestUrl = process.env.INNGEST_EVENT_URL || "https://inn.gs/e";
      await fetch(inngestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${INNGEST_EVENT_KEY}` },
        body: JSON.stringify({
          name: "ticket/inbound-message",
          data: {
            workspace_id: ticket.workspace_id,
            ticket_id: crisisInfo.ticketId,
            message_body: latestMsg.body_clean || latestMsg.body || "",
            channel: "email",
            is_new_ticket: false,
          },
        }),
      });
      console.log(`    ✓ Merged, closed orphan, re-triggered handler`);
    } else {
      console.log(`    ✓ Merged, closed orphan (no Inngest key — handler not triggered)`);
    }

    merged++;
  }

  console.log(`\n${isExecute ? "✅" : "📋"} ${merged} ticket(s) ${isExecute ? "merged" : "would be merged"}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
