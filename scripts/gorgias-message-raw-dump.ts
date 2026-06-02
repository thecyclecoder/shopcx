#!/usr/bin/env npx tsx
/**
 * Pull the raw Gorgias message payload so we can find where the Gmail
 * Message-ID lives. Listing-API returns external_id=null, but the
 * headers may be on a different field or only on the per-message GET.
 */

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

async function gFetch(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
// Two test tickets — Janet (#268834316) has 2 messages including an
// inbound; Kathy Frahm (#268526050) has 1.
const TICKETS = [268834316, 268526050];

for (const tid of TICKETS) {
  console.log(`\n════════════════════════════════════════`);
  console.log(`Ticket ${tid}`);
  console.log(`════════════════════════════════════════`);

  // 1. Listing — what we already get
  const list = await gFetch(`/tickets/${tid}/messages?limit=30`);
  console.log(`\n--- /tickets/${tid}/messages?limit=30 (listing keys) ---`);
  for (const m of list.data || []) {
    console.log(`Message ${m.id} (from_agent=${m.from_agent}):`);
    console.log(`  keys: ${Object.keys(m).join(", ")}`);
    console.log(`  external_id: ${m.external_id}`);
    console.log(`  message_id: ${m.message_id}`);
    console.log(`  source.type: ${m.source?.type}`);
    if (m.source) console.log(`  source keys: ${Object.keys(m.source).join(", ")}`);
  }

  // 2. Per-message GET — usually returns more fields
  const firstMsgId = list.data?.[0]?.id;
  if (firstMsgId) {
    console.log(`\n--- /tickets/${tid}/messages/${firstMsgId} (full single-message GET) ---`);
    const single = await gFetch(`/tickets/${tid}/messages/${firstMsgId}`);
    console.log(JSON.stringify(single, null, 2).slice(0, 5000));
  }
}
}
main().catch(e => { console.error(e); process.exit(1); });
