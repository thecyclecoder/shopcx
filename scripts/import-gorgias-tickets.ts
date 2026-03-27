#!/usr/bin/env npx tsx
/**
 * Gorgias Ticket History Import
 *
 * Imports closed tickets from the last 90 days into ShopCX.
 * Standalone script — not part of the app code.
 *
 * Usage:
 *   cd /Users/admin/Projects/shopcx
 *   npx tsx scripts/import-gorgias-tickets.ts [--dry-run] [--limit N]
 *
 * Requires .env.local with:
 *   GORGIAS_DOMAIN, GORGIAS_EMAIL, GORGIAS_API_KEY
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });

// ── Config ──

const GORGIAS_DOMAIN = process.env.GORGIAS_DOMAIN!;
const GORGIAS_EMAIL = process.env.GORGIAS_EMAIL!;
const GORGIAS_API_KEY = process.env.GORGIAS_API_KEY!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

if (!GORGIAS_DOMAIN || !GORGIAS_EMAIL || !GORGIAS_API_KEY) {
  console.error("Missing Gorgias credentials in .env.local");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing Supabase credentials in .env.local");
  process.exit(1);
}

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARG = process.argv.indexOf("--limit");
const MAX_TICKETS = LIMIT_ARG !== -1 ? parseInt(process.argv[LIMIT_ARG + 1], 10) : Infinity;

const auth = Buffer.from(`${GORGIAS_EMAIL}:${GORGIAS_API_KEY}`).toString("base64");
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const GORGIAS_BASE = `https://${GORGIAS_DOMAIN}.gorgias.com/api`;
const NINETY_DAYS_AGO = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

// ── Rate limiter: max 2 req/sec ──

let lastRequestAt = 0;
async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < 500) {
    await new Promise((r) => setTimeout(r, 500 - elapsed));
  }
  lastRequestAt = Date.now();

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
    console.log(`  Rate limited, waiting ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return rateLimitedFetch(url);
  }

  if (!res.ok) {
    throw new Error(`Gorgias API ${res.status}: ${await res.text()}`);
  }

  return res;
}

// ── Gorgias API ──

interface GorgiasTicket {
  id: number;
  subject: string | null;
  status: string;
  channel: string;
  created_datetime: string;
  closed_datetime: string | null;
  customer: { email: string; name: string | null } | null;
  tags: { name: string }[];
}

interface GorgiasMessage {
  id: number;
  body_text: string | null;
  body_html: string | null;
  from_agent: boolean;
  created_datetime: string;
  source: { type: string } | null;
}

async function fetchClosedTickets(): Promise<GorgiasTicket[]> {
  const tickets: GorgiasTicket[] = [];
  let cursor: string | null = null;

  while (tickets.length < MAX_TICKETS) {
    const params = new URLSearchParams({
      limit: "100",
      order_by: "created_datetime:desc",
    });
    if (cursor) params.set("cursor", cursor);

    const url = `${GORGIAS_BASE}/tickets?${params}`;
    const res = await rateLimitedFetch(url);
    const data = await res.json();

    if (!data.data?.length) break;

    for (const t of data.data) {
      // Only import closed tickets from last 90 days
      if (t.status !== "closed") continue;
      if (t.created_datetime < NINETY_DAYS_AGO) {
        // We've gone past 90 days, stop paginating
        return tickets.slice(0, MAX_TICKETS);
      }
      tickets.push(t);
      if (tickets.length >= MAX_TICKETS) break;
    }

    // Check if we've gone past 90 days (last ticket in page)
    const lastTicket = data.data[data.data.length - 1];
    if (lastTicket.created_datetime < NINETY_DAYS_AGO) break;

    cursor = data.meta?.next_cursor;
    if (!cursor) break;

    console.log(`  Fetched ${tickets.length} closed tickets so far...`);
  }

  return tickets.slice(0, MAX_TICKETS);
}

async function fetchTicketMessages(ticketId: number): Promise<GorgiasMessage[]> {
  const res = await rateLimitedFetch(`${GORGIAS_BASE}/tickets/${ticketId}/messages?limit=30`);
  const data = await res.json();
  return data.data || [];
}

// ── Customer lookup cache ──

const customerCache = new Map<string, string | null>();

async function findCustomerId(email: string): Promise<string | null> {
  if (customerCache.has(email)) return customerCache.get(email)!;

  const { data } = await admin
    .from("customers")
    .select("id")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("email", email.toLowerCase())
    .limit(1)
    .single();

  const id = data?.id || null;
  customerCache.set(email, id);
  return id;
}

// ── Dedup: check which gorgias_ids already exist ──

async function getExistingGorgiasIds(ids: number[]): Promise<Set<number>> {
  const existing = new Set<number>();
  // Query in batches of 500
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const { data } = await admin
      .from("tickets")
      .select("gorgias_id")
      .eq("workspace_id", WORKSPACE_ID)
      .in("gorgias_id", batch);

    if (data) {
      for (const row of data) {
        if (row.gorgias_id) existing.add(row.gorgias_id);
      }
    }
  }
  return existing;
}

// ── Map Gorgias channel to ShopCX channel ──

function mapChannel(gorgiasChannel: string): string {
  const channelMap: Record<string, string> = {
    email: "email",
    chat: "chat",
    "social-comment": "social_comments",
    "facebook-messenger": "meta_dm",
    "instagram-ad-comment": "social_comments",
    "instagram-comment": "social_comments",
    "instagram-dm": "meta_dm",
    sms: "sms",
    "help-center": "help_center",
    internal: "email",
    phone: "email",
    yotpo: "email",
  };
  return channelMap[gorgiasChannel] || "email";
}

// ── Main import ──

async function main() {
  console.log("Gorgias Ticket Import");
  console.log(`  Workspace: ${WORKSPACE_ID}`);
  console.log(`  Gorgias domain: ${GORGIAS_DOMAIN}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`  Max tickets: ${MAX_TICKETS === Infinity ? "all" : MAX_TICKETS}`);
  console.log(`  Date range: last 90 days (since ${NINETY_DAYS_AGO.split("T")[0]})`);
  console.log("");

  // Step 1: Fetch closed tickets from Gorgias
  console.log("Fetching closed tickets from Gorgias...");
  const gorgiasTickets = await fetchClosedTickets();
  console.log(`Found ${gorgiasTickets.length} closed tickets\n`);

  if (gorgiasTickets.length === 0) {
    console.log("No tickets to import.");
    return;
  }

  // Step 2: Check which ones already exist
  const gorgiasIds = gorgiasTickets.map((t) => t.id);
  const existingIds = await getExistingGorgiasIds(gorgiasIds);
  const newTickets = gorgiasTickets.filter((t) => !existingIds.has(t.id));
  console.log(`${existingIds.size} already imported, ${newTickets.length} new to import\n`);

  if (newTickets.length === 0) {
    console.log("All tickets already imported.");
    return;
  }

  if (DRY_RUN) {
    console.log("DRY RUN — would import:");
    for (const t of newTickets.slice(0, 20)) {
      console.log(`  #${t.id} "${t.subject}" (${t.customer?.email || "no email"}) ${t.channel}`);
    }
    if (newTickets.length > 20) console.log(`  ... and ${newTickets.length - 20} more`);
    return;
  }

  // Step 3: Import each ticket
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const gt of newTickets) {
    try {
      // Find customer
      const customerEmail = gt.customer?.email;
      const customerId = customerEmail ? await findCustomerId(customerEmail) : null;

      // Map tags
      const tags = [
        "gorgias-import",
        ...(gt.tags || []).map((t) => t.name),
      ];

      // Insert ticket
      const { data: ticket, error: ticketError } = await admin
        .from("tickets")
        .insert({
          workspace_id: WORKSPACE_ID,
          gorgias_id: gt.id,
          customer_id: customerId,
          subject: gt.subject || "(no subject)",
          status: "closed",
          channel: mapChannel(gt.channel),
          tags,
          created_at: gt.created_datetime,
          resolved_at: gt.closed_datetime,
          handled_by: "Gorgias Import",
        })
        .select("id")
        .single();

      if (ticketError) {
        // Could be duplicate (race condition) — skip
        if (ticketError.code === "23505") {
          skipped++;
          continue;
        }
        throw ticketError;
      }

      // Fetch and insert messages
      const messages = await fetchTicketMessages(gt.id);
      if (messages.length > 0) {
        const messageBatch = messages.map((m) => ({
          ticket_id: ticket.id,
          direction: m.from_agent ? "outbound" as const : "inbound" as const,
          visibility: "external" as const,
          author_type: m.from_agent ? "agent" as const : "customer" as const,
          body: m.body_text || m.body_html || "(empty message)",
          created_at: m.created_datetime,
        }));

        const { error: msgError } = await admin
          .from("ticket_messages")
          .insert(messageBatch);

        if (msgError) {
          console.error(`  Warning: failed to insert messages for Gorgias #${gt.id}: ${msgError.message}`);
        }
      }

      imported++;
      if (imported % 25 === 0) {
        console.log(`  Imported ${imported}/${newTickets.length} (${skipped} skipped, ${errors} errors)`);
      }
    } catch (err) {
      errors++;
      console.error(`  Error importing Gorgias #${gt.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\nImport complete!");
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped (already existed): ${skipped}`);
  console.log(`  Errors: ${errors}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
