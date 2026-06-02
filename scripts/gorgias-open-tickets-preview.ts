#!/usr/bin/env npx tsx
/**
 * Migration preview: pull every OPEN ticket from Gorgias and show what
 * the import into ShopCX would look like. Read-only — does not write.
 *
 * Usage:
 *   npx tsx scripts/gorgias-open-tickets-preview.ts
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

const GORGIAS_DOMAIN = process.env.GORGIAS_DOMAIN!;
const GORGIAS_EMAIL = process.env.GORGIAS_EMAIL!;
const GORGIAS_API_KEY = process.env.GORGIAS_API_KEY!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

if (!GORGIAS_DOMAIN || !GORGIAS_EMAIL || !GORGIAS_API_KEY) {
  console.error("Missing Gorgias creds in .env.local");
  process.exit(1);
}

const auth = Buffer.from(`${GORGIAS_EMAIL}:${GORGIAS_API_KEY}`).toString("base64");
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const GORGIAS_BASE = `https://${GORGIAS_DOMAIN}.gorgias.com/api`;

let lastReq = 0;
async function gorgiasFetch(path: string): Promise<Response> {
  const elapsed = Date.now() - lastReq;
  if (elapsed < 500) await new Promise((r) => setTimeout(r, 500 - elapsed));
  lastReq = Date.now();
  const res = await fetch(`${GORGIAS_BASE}${path}`, {
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
  });
  if (res.status === 429) {
    const retry = parseInt(res.headers.get("Retry-After") || "5", 10);
    await new Promise((r) => setTimeout(r, retry * 1000));
    return gorgiasFetch(path);
  }
  if (!res.ok) throw new Error(`Gorgias ${res.status}: ${await res.text()}`);
  return res;
}

interface GorgiasTicket {
  id: number;
  subject: string | null;
  status: string;
  channel: string;
  created_datetime: string;
  updated_datetime: string;
  customer: { id: number; email: string | null; name: string | null } | null;
  tags: { name: string }[];
  assignee_user: { id: number; email: string; name: string | null } | null;
  via: string | null;
  language: string | null;
}

interface GorgiasMessage {
  id: number;
  body_text: string | null;
  body_html: string | null;
  from_agent: boolean;
  created_datetime: string;
  source: { type: string; from?: { name?: string; address?: string } } | null;
  external_id: string | null;
  subject: string | null;
}

function mapChannel(g: string): string {
  const m: Record<string, string> = {
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
  return m[g] || "email";
}

async function main() {
  console.log(`Gorgias open-ticket migration preview`);
  console.log(`  Domain: ${GORGIAS_DOMAIN}.gorgias.com`);
  console.log(`  Workspace: ${WORKSPACE_ID}\n`);

  // Paginate updated-desc and collect every non-closed ticket. CX
  // manager said there are 9 open — we keep going until we have at
  // least that many, or until we've scanned 5 pages × 30 (well past
  // 9 in any reasonable scenario).
  const all: GorgiasTicket[] = [];
  let cursor: string | null = null;
  let pages = 0;
  while (pages < 5) {
    const params = new URLSearchParams({ limit: "30", order_by: "updated_datetime:desc" });
    if (cursor) params.set("cursor", cursor);
    const res = await gorgiasFetch(`/tickets?${params}`);
    const data = await res.json();
    const batch = (data.data || []) as GorgiasTicket[];
    if (!batch.length) break;
    all.push(...batch);
    pages += 1;
    cursor = data.meta?.next_cursor || null;
    if (!cursor) break;
  }
  console.log(`Pulled ${all.length} tickets across ${pages} page(s).`);
  const statusCounts: Record<string, number> = {};
  for (const t of all) statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
  console.log(`Status breakdown: ${JSON.stringify(statusCounts)}\n`);
  const open = all.filter(t => t.status !== "closed");
  console.log(`Of those, ${open.length} are not closed.\n`);

  if (open.length === 0) return;

  // Existing dedup
  const existingIds = new Set<number>();
  for (let i = 0; i < open.length; i += 100) {
    const batch = open.slice(i, i + 100).map(t => t.id);
    const { data } = await admin
      .from("tickets")
      .select("gorgias_id")
      .eq("workspace_id", WORKSPACE_ID)
      .in("gorgias_id", batch);
    for (const r of data || []) if (r.gorgias_id) existingIds.add(r.gorgias_id);
  }

  // Per-ticket detail
  for (const t of open) {
    console.log(`────────────────────────────────────────`);
    console.log(`Gorgias #${t.id}  [${t.status}]  ${t.channel} → ShopCX channel: ${mapChannel(t.channel)}`);
    if (existingIds.has(t.id)) console.log(`  ⚠ Already imported (gorgias_id ${t.id} exists in our DB)`);
    console.log(`  Subject: ${t.subject || "(none)"}`);
    console.log(`  Created: ${t.created_datetime?.slice(0, 16)}  Updated: ${t.updated_datetime?.slice(0, 16)}`);
    console.log(`  Assignee: ${t.assignee_user?.name || t.assignee_user?.email || "—"}`);
    console.log(`  Tags: ${(t.tags || []).map(x => x.name).join(", ") || "—"}`);

    // Customer
    const email = t.customer?.email?.toLowerCase() || null;
    const name = t.customer?.name || "—";
    let dbCustomerId: string | null = null;
    let dbHasShopify = false;
    if (email) {
      const { data: c } = await admin
        .from("customers")
        .select("id, shopify_customer_id, first_name, last_name")
        .eq("workspace_id", WORKSPACE_ID)
        .eq("email", email)
        .maybeSingle();
      dbCustomerId = c?.id || null;
      dbHasShopify = !!c?.shopify_customer_id;
      console.log(`  Customer: ${name} <${email}>  ${dbCustomerId ? "✓ in DB" : "✗ NOT in DB"}${dbHasShopify ? " (Shopify-linked)" : ""}`);
    } else {
      console.log(`  Customer: ${name} <(no email)>  ✗ NOT in DB`);
    }

    // Messages
    const msgRes = await gorgiasFetch(`/tickets/${t.id}/messages?limit=30`);
    const msgData = await msgRes.json();
    const msgs: GorgiasMessage[] = msgData.data || [];
    console.log(`  Messages: ${msgs.length}`);
    const recent = msgs.slice(-3);
    for (const m of recent) {
      const who = m.from_agent ? "agent" : "customer";
      const body = (m.body_text || (m.body_html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      console.log(`    [${m.created_datetime?.slice(0, 16)}] ${who}: ${body.slice(0, 140)}${body.length > 140 ? "…" : ""}`);
    }

    // Email threading hint — last inbound message's external_id IS the
    // Gmail Message-ID we need so the customer's next reply threads back
    // into THIS ticket once forwarding flips to ShopCX.
    const lastInbound = [...msgs].reverse().find(m => !m.from_agent);
    if (lastInbound?.external_id) {
      console.log(`  Last inbound external_id (for threading): ${lastInbound.external_id}`);
    } else if (mapChannel(t.channel) === "email") {
      console.log(`  ⚠ No external_id on last inbound — replies may not thread back automatically`);
    }
    console.log();
  }

  // Summary
  console.log("════════════════════════════════════════");
  console.log(`Summary:`);
  console.log(`  Total open tickets in Gorgias: ${open.length}`);
  console.log(`  Already imported: ${[...existingIds].length}`);
  console.log(`  Net new to import: ${open.length - existingIds.size}`);
  const channelCounts: Record<string, number> = {};
  for (const t of open) {
    if (existingIds.has(t.id)) continue;
    const c = mapChannel(t.channel);
    channelCounts[c] = (channelCounts[c] || 0) + 1;
  }
  console.log(`  By channel:`);
  for (const [c, n] of Object.entries(channelCounts)) console.log(`    ${c}: ${n}`);
}

main().catch(e => { console.error(e); process.exit(1); });
