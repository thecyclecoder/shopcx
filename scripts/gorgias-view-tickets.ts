#!/usr/bin/env npx tsx
/**
 * Pull the tickets the CX team sees in a specific Gorgias saved view.
 * Default: view 53071 ("Open").
 *
 * Usage:
 *   npx tsx scripts/gorgias-view-tickets.ts            # uses 53071 = "Open"
 *   npx tsx scripts/gorgias-view-tickets.ts <view_id>
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

const D = process.env.GORGIAS_DOMAIN!;
const auth = Buffer.from(`${process.env.GORGIAS_EMAIL}:${process.env.GORGIAS_API_KEY}`).toString("base64");
const BASE = `https://${D}.gorgias.com/api`;
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const VIEW_ID = process.argv[2] || "53071";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let last = 0;
async function gFetch(path: string) {
  const e = Date.now() - last;
  if (e < 500) await new Promise(r => setTimeout(r, 500 - e));
  last = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
  });
  if (res.status === 429) {
    const r = parseInt(res.headers.get("Retry-After") || "5", 10);
    await new Promise(x => setTimeout(x, r * 1000));
    return gFetch(path);
  }
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

interface ViewItem { id: number; subject: string; status: string; channel: string; updated_datetime: string; }

async function main() {
  console.log(`Pulling Gorgias view ${VIEW_ID}\n`);

  // Fetch view metadata
  const viewMeta = await gFetch(`/views/${VIEW_ID}`);
  console.log(`View: "${viewMeta.name}"  shared=${viewMeta.shared}\n`);

  // Pull items in this view
  const items: ViewItem[] = [];
  let cursor: string | null = null;
  while (items.length < 100) {
    const params = new URLSearchParams({ limit: "30" });
    if (cursor) params.set("cursor", cursor);
    const res = await gFetch(`/views/${VIEW_ID}/items?${params}`);
    const batch = (res.data || []) as ViewItem[];
    items.push(...batch);
    cursor = res.meta?.next_cursor || null;
    if (!cursor || batch.length === 0) break;
  }
  console.log(`${items.length} ticket(s) in this view.\n`);

  // Per-ticket detail using single-message GET so we get message_id
  for (const item of items) {
    const t = await gFetch(`/tickets/${item.id}`);
    const msgList = await gFetch(`/tickets/${item.id}/messages?limit=30`);
    const msgs = msgList.data || [];

    // Email match in our DB
    const email = (t.customer?.email || "").toLowerCase();
    const { data: dbCust } = email
      ? await admin.from("customers").select("id, shopify_customer_id").eq("workspace_id", W).eq("email", email).maybeSingle()
      : { data: null };

    console.log(`────────────────────────────────────────`);
    console.log(`Gorgias #${t.id}  [${t.status}]  ${t.channel}`);
    console.log(`  Subject: ${t.subject || "(none)"}`);
    console.log(`  Customer: ${t.customer?.name || "—"} <${email || "no email"}>  ${dbCust ? "✓ in DB" : "✗ NOT in DB"}${dbCust?.shopify_customer_id ? " (Shopify-linked)" : ""}`);
    console.log(`  Created ${t.created_datetime?.slice(0,16)}  Updated ${t.updated_datetime?.slice(0,16)}`);
    console.log(`  Tags: ${(t.tags || []).map((x: { name: string }) => x.name).join(", ") || "—"}`);
    console.log(`  Assignee: ${t.assignee_user?.name || t.assignee_user?.email || "—"}`);
    console.log(`  Messages: ${msgs.length}`);

    // Last inbound — show its message_id (the threading anchor)
    const lastInbound = [...msgs].reverse().find((m: { from_agent: boolean }) => !m.from_agent);
    if (lastInbound) {
      const body = (lastInbound.body_text || (lastInbound.body_html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      console.log(`  Last customer msg [${lastInbound.created_datetime?.slice(0,16)}]:`);
      console.log(`    ${body.slice(0, 200)}${body.length > 200 ? "…" : ""}`);
      console.log(`  Threading Message-ID: ${lastInbound.message_id || "⚠ MISSING"}`);
    }
    console.log();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
