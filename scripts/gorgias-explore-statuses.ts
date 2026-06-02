#!/usr/bin/env npx tsx
/**
 * Explore Gorgias's actual status values + saved views, so we can find
 * what the CX manager sees as "9 open".
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
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function main() {
  // 1. Try the "new" status filter explicitly via search
  console.log("─── Probe: status='new' via /tickets/search ───");
  try {
    const res = await gFetch("/tickets/search?status=new&limit=5");
    console.log(`  ${res.data?.length || 0} returned`);
    for (const t of (res.data || []).slice(0, 5)) {
      console.log(`    #${t.id} status=${t.status} subject="${(t.subject || "").slice(0, 60)}"`);
    }
  } catch (e) {
    console.log(`  search not available or rejected: ${(e as Error).message}`);
  }

  // 2. Listing with a fuller scan — count distinct statuses
  console.log("\n─── Wide scan: 10 pages, distinct status values ───");
  const statusCount: Record<string, number> = {};
  let cursor: string | null = null;
  for (let p = 0; p < 10; p++) {
    const params = new URLSearchParams({ limit: "100", order_by: "updated_datetime:desc" });
    if (cursor) params.set("cursor", cursor);
    const res = await gFetch(`/tickets?${params}`);
    for (const t of res.data || []) statusCount[t.status] = (statusCount[t.status] || 0) + 1;
    cursor = res.meta?.next_cursor;
    if (!cursor) break;
  }
  console.log(`  ${JSON.stringify(statusCount, null, 2)}`);

  // 3. Saved views — these usually drive the "Open" sidebar count the CX team sees
  console.log("\n─── Views (what the CX team's UI sidebar shows) ───");
  try {
    const res = await gFetch("/views?limit=30");
    for (const v of res.data || []) {
      console.log(`  view ${v.id}  "${v.name}"  count=${v.last_known_count ?? v.count ?? "?"}  shared=${v.shared}`);
    }
  } catch (e) {
    console.log(`  views endpoint failed: ${(e as Error).message}`);
  }

  // 4. If a view named like "Open" / "Inbox" exists, fetch its first 20 tickets
  // (we may not have access to filter, so just dump the names — pick by hand)
  console.log("\nIf one of those views shows a 9-count, we can pull tickets from it:");
  console.log("  /api/views/<id>/items?limit=30");
}

main().catch(e => { console.error(e); process.exit(1); });
