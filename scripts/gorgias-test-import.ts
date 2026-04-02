#!/usr/bin/env npx tsx
/**
 * Gorgias Test Import — Import one ticket at a time for AI testing
 *
 * Fetches multi-turn tickets from Gorgias (agent-touched), imports ONLY
 * the opening customer message into ShopCX so we can test how our AI
 * would have handled it.
 *
 * Usage:
 *   npx tsx scripts/gorgias-test-import.ts              # show next candidate
 *   npx tsx scripts/gorgias-test-import.ts --import      # import the next one
 *   npx tsx scripts/gorgias-test-import.ts --skip        # skip and show the next
 *   npx tsx scripts/gorgias-test-import.ts --list 10     # list 10 candidates
 *
 * Requires .env.local with GORGIAS_DOMAIN, GORGIAS_EMAIL, GORGIAS_API_KEY
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

// Load .env.local
const envPath = resolve(process.cwd(), ".env.local");
try {
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

const GORGIAS_DOMAIN = process.env.GORGIAS_DOMAIN!;
const GORGIAS_EMAIL = process.env.GORGIAS_EMAIL!;
const GORGIAS_API_KEY = process.env.GORGIAS_API_KEY!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

if (!GORGIAS_DOMAIN || !GORGIAS_EMAIL || !GORGIAS_API_KEY) {
  console.error("Missing Gorgias credentials in .env.local");
  process.exit(1);
}

const auth = Buffer.from(`${GORGIAS_EMAIL}:${GORGIAS_API_KEY}`).toString("base64");
const admin = createClient(SUPABASE_URL, SUPABASE_KEY);
const GORGIAS_BASE = `https://${GORGIAS_DOMAIN}.gorgias.com/api`;

// State file to track which tickets we've already seen
const stateFile = resolve(process.cwd(), "scripts/.gorgias-test-cursor.json");
let cursor: { page: number; skipped: string[] } = { page: 1, skipped: [] };
try { cursor = JSON.parse(readFileSync(stateFile, "utf8")); } catch {}

function saveCursor() {
  const { writeFileSync } = require("fs");
  writeFileSync(stateFile, JSON.stringify(cursor, null, 2));
}

async function gorgiasGet(path: string) {
  const res = await fetch(`${GORGIAS_BASE}${path}`, {
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Gorgias API ${res.status}: ${await res.text()}`);
  return res.json();
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface GorgiasTicket {
  id: number;
  subject: string;
  status: string;
  channel: string;
  created_datetime: string;
  customer: { email: string; name: string };
  messages: { sender: { type: string; name?: string }; body_text?: string; body_html?: string; created_datetime: string }[];
  assignee_user?: { firstname: string; lastname: string };
  tags: { name: string }[];
}

async function findCandidates(count: number): Promise<GorgiasTicket[]> {
  const candidates: GorgiasTicket[] = [];
  let page = cursor.page;

  while (candidates.length < count) {
    console.log(`  Fetching Gorgias page ${page}...`);
    const data = await gorgiasGet(`/tickets?limit=25&page=${page}&order_by=created_datetime:desc&status=closed`);
    const tickets = data.data || [];

    if (tickets.length === 0) break;

    for (const t of tickets) {
      if (cursor.skipped.includes(String(t.id))) continue;

      // Fetch full ticket with messages
      const full = await gorgiasGet(`/tickets/${t.id}/messages?limit=50`);
      const messages = full.data || [];

      // Must have 3+ messages (multi-turn) and at least one agent reply
      if (messages.length < 3) continue;
      const hasAgentReply = messages.some((m: { sender: { type: string } }) => m.sender?.type === "user");
      if (!hasAgentReply) continue;

      // First message must be from customer
      const firstMsg = messages[messages.length - 1]; // Gorgias returns newest first
      if (firstMsg?.sender?.type !== "customer") continue;

      const ticket: GorgiasTicket = {
        ...t,
        messages: messages.reverse(), // oldest first
      };

      candidates.push(ticket);
      if (candidates.length >= count) break;

      // Rate limit
      await new Promise(r => setTimeout(r, 500));
    }

    page++;
    cursor.page = page;
    saveCursor();

    if (tickets.length < 25) break;
  }

  return candidates;
}

async function importTicket(ticket: GorgiasTicket) {
  const firstMessage = ticket.messages[0];
  const customerEmail = ticket.customer?.email;
  const body = firstMessage.body_text || stripHtml(firstMessage.body_html || "");

  if (!customerEmail || !body) {
    console.log("  Skipping — no email or body");
    return;
  }

  // Find customer in our DB
  const { data: customer } = await admin.from("customers")
    .select("id")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("email", customerEmail)
    .single();

  // Create ticket
  const { data: newTicket, error } = await admin.from("tickets").insert({
    workspace_id: WORKSPACE_ID,
    customer_id: customer?.id || null,
    subject: ticket.subject || "Imported test ticket",
    status: "open",
    channel: "email",
    tags: ["test:gorgias", `gorgias:${ticket.id}`],
  }).select("id").single();

  if (error || !newTicket) {
    console.error("  Failed to create ticket:", error?.message);
    return;
  }

  // Insert opening message only
  await admin.from("ticket_messages").insert({
    ticket_id: newTicket.id,
    direction: "inbound",
    visibility: "external",
    author_type: "customer",
    body,
  });

  console.log(`  Imported ticket ${newTicket.id}`);
  console.log(`  From: ${customerEmail}`);
  console.log(`  Subject: ${ticket.subject}`);
  console.log(`  Original Gorgias #${ticket.id} (${ticket.messages.length} messages)`);
  console.log(`  Opening message: ${body.slice(0, 200)}${body.length > 200 ? "..." : ""}`);
  console.log();
  console.log(`  Original agent replies for comparison:`);
  for (const m of ticket.messages.slice(1)) {
    if (m.sender?.type === "user") {
      const agentBody = m.body_text || stripHtml(m.body_html || "");
      console.log(`    [${m.sender.name || "Agent"}]: ${agentBody.slice(0, 150)}${agentBody.length > 150 ? "..." : ""}`);
    }
  }
}

async function main() {
  const doImport = process.argv.includes("--import");
  const doSkip = process.argv.includes("--skip");
  const listIdx = process.argv.indexOf("--list");
  const listCount = listIdx !== -1 ? parseInt(process.argv[listIdx + 1]) || 5 : 1;

  const count = listIdx !== -1 ? listCount : 1;
  console.log(`Finding ${count} candidate ticket(s)...\n`);

  const candidates = await findCandidates(count);

  if (candidates.length === 0) {
    console.log("No more candidates found.");
    return;
  }

  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    const firstMsg = t.messages[0];
    const body = firstMsg.body_text || stripHtml(firstMsg.body_html || "");

    console.log(`--- Candidate ${i + 1} ---`);
    console.log(`Gorgias #${t.id} | ${t.customer?.email} | ${t.messages.length} messages`);
    console.log(`Subject: ${t.subject}`);
    console.log(`Opening: ${body.slice(0, 300)}${body.length > 300 ? "..." : ""}`);
    console.log();

    if (i === 0 && doImport) {
      console.log("Importing...\n");
      await importTicket(t);
      cursor.skipped.push(String(t.id));
      saveCursor();
    } else if (i === 0 && doSkip) {
      console.log("Skipped.\n");
      cursor.skipped.push(String(t.id));
      saveCursor();
    } else if (!doImport && !doSkip && i === 0) {
      console.log("Run with --import to import this ticket, or --skip to skip it.\n");
    }
  }
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
