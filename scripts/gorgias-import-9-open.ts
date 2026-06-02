#!/usr/bin/env npx tsx
/**
 * Migration import: bring the 9 open Gorgias tickets into ShopCX.
 *
 *   - Imports as status='open' so they show up in the queue
 *   - Maps channel and preserves selected Gorgias tags
 *   - Sets ticket.email_message_id from the LAST message's message_id
 *     (regardless of direction) — that's the In-Reply-To anchor the
 *     customer's next reply will use after forwarding flips to ShopCX
 *   - Inserts every Gorgias message as a ticket_messages row
 *   - Tags ticket with `gorgias-import` for tracking
 *
 *   Does NOT mark agent_intervened — we want the AI to handle the
 *   next inbound normally (this is the whole point of the migration).
 *
 * Usage:
 *   npx tsx scripts/gorgias-import-9-open.ts          # dry run
 *   npx tsx scripts/gorgias-import-9-open.ts --apply  # do it
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

const APPLY = process.argv.includes("--apply");
const D = process.env.GORGIAS_DOMAIN!;
const auth = Buffer.from(`${process.env.GORGIAS_EMAIL}:${process.env.GORGIAS_API_KEY}`).toString("base64");
const BASE = `https://${D}.gorgias.com/api`;
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// 9 tickets from view 207012 ("All"), per the CX manager — wholesale
// partnership ticket #268712230 deliberately excluded.
const TARGETS = [
  268834316, // Janet — wrong flavor (Mixed Berry rejection)
  268815573, // Frederick Jaudon — cancel + account error
  268795394, // Barbara Wedin — apply $15 reward
  268755630, // Gretchen Merten — confirm cancel
  268752661, // Marlene Drasher — return shipment + cancel
  268747388, // Ashley Denson — order status
  268731115, // Bridget Trymbulak — cancel ("Stop sending!!")
  268729006, // Heidi Schnier — cancel subscription
  268702486, // Roxana Magana — double charge / refund
];

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

function mapChannel(g: string): string {
  const m: Record<string, string> = {
    email: "email",
    chat: "chat",
    contact_form: "email", // form submissions thread back via email replies
    "help-center": "help_center",
    "social-comment": "social_comments",
    "facebook-messenger": "meta_dm",
    "instagram-comment": "social_comments",
    "instagram-dm": "meta_dm",
    sms: "sms",
    phone: "email",
    yotpo: "email",
    internal: "email",
  };
  return m[g] || "email";
}

// Tags from Gorgias we DON'T want to carry forward — internal Gorgias/Siena bookkeeping
const SKIP_TAGS = new Set([
  "during-business-hours",
  "auto-assign-from-siena",
  "handled-by-siena",
  "siena-close-failed",
  "siena_follow_up",
]);

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");
  console.log(`Importing ${TARGETS.length} open Gorgias tickets into ShopCX\n`);

  // Dedup: any of these already imported?
  const { data: dupRows } = await admin
    .from("tickets")
    .select("gorgias_id")
    .eq("workspace_id", W)
    .in("gorgias_id", TARGETS);
  const alreadyImported = new Set((dupRows || []).map(r => r.gorgias_id));
  if (alreadyImported.size > 0) console.log(`  ${alreadyImported.size} already imported — will skip those\n`);

  let imported = 0;
  for (const tid of TARGETS) {
    console.log(`────────────────────────────────────────`);
    console.log(`Gorgias #${tid}`);

    if (alreadyImported.has(tid)) {
      console.log("  ⚠ already imported, skipping\n");
      continue;
    }

    const t = await gFetch(`/tickets/${tid}`);
    const msgList = await gFetch(`/tickets/${tid}/messages?limit=30`);
    const msgs = msgList.data || [];

    const email = (t.customer?.email || "").toLowerCase();
    const { data: dbCust } = email
      ? await admin
          .from("customers")
          .select("id, first_name")
          .eq("workspace_id", W)
          .eq("email", email)
          .maybeSingle()
      : { data: null };

    // Threading anchor — the last message's message_id (regardless of direction).
    // This is what the customer's next reply will In-Reply-To.
    const last = msgs[msgs.length - 1];
    const threadingId = last?.message_id || null;

    // Tags: filter out Siena/Gorgias bookkeeping, keep the meaningful ones, add gorgias-import
    const tags = ["gorgias-import"];
    for (const tag of (t.tags || []) as { name: string }[]) {
      if (!SKIP_TAGS.has(tag.name)) tags.push(tag.name);
    }

    const subject = t.subject || "(no subject)";
    const channel = mapChannel(t.channel);
    console.log(`  Subject: ${subject}`);
    console.log(`  Customer: ${t.customer?.name} <${email}>  ${dbCust ? "✓" : "✗ no DB match"}`);
    console.log(`  Channel: ${t.channel} → ${channel}`);
    console.log(`  Messages: ${msgs.length} (would insert all)`);
    console.log(`  Threading anchor (email_message_id): ${threadingId || "⚠ MISSING — replies may not thread"}`);
    console.log(`  Tags: ${tags.join(", ")}`);

    if (!APPLY) continue;

    const { data: newTicket, error: tErr } = await admin
      .from("tickets")
      .insert({
        workspace_id: W,
        gorgias_id: tid,
        customer_id: dbCust?.id || null,
        subject,
        status: "open",
        channel,
        tags,
        email_message_id: threadingId,
        created_at: t.created_datetime,
      })
      .select("id")
      .single();
    if (tErr) {
      if (tErr.code === "23505") {
        console.log("  ⚠ unique-constraint hit on gorgias_id — already imported");
        continue;
      }
      console.log(`  ✗ insert failed: ${tErr.message}`);
      continue;
    }
    console.log(`  ✓ inserted ticket ${newTicket.id}`);

    // Insert messages
    const rows = msgs.map((m: { from_agent: boolean; body_text: string | null; body_html: string | null; created_datetime: string; message_id: string | null }) => ({
      ticket_id: newTicket.id,
      direction: m.from_agent ? "outbound" : "inbound",
      visibility: "external",
      author_type: m.from_agent ? "agent" : "customer",
      body: m.body_html || m.body_text || "(empty)",
      body_clean: (m.body_text || (m.body_html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
      created_at: m.created_datetime,
      email_message_id: m.message_id || null,
      sent_at: m.from_agent ? m.created_datetime : null,
    }));
    const { error: mErr } = await admin.from("ticket_messages").insert(rows);
    if (mErr) console.log(`  ⚠ message insert error: ${mErr.message}`);
    else console.log(`  ✓ inserted ${rows.length} messages`);

    // Internal note for agent context
    await admin.from("ticket_messages").insert({
      ticket_id: newTicket.id,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] Imported from Gorgias #${tid} as part of the ${new Date().toISOString().slice(0, 10)} migration cutover. Threading anchored on Message-ID ${threadingId || "(none)"}.`,
    });

    imported++;
    console.log();
  }

  console.log(`\n${APPLY ? "✅" : "🔍"} Summary: ${imported} ticket(s) ${APPLY ? "imported" : "would be imported"} (out of ${TARGETS.length}).`);
  if (!APPLY) console.log("\nRe-run with --apply to actually import.");
}

main().catch(e => { console.error(e); process.exit(1); });
