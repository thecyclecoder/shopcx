/**
 * Look at a ticket where the playbook is working but analysis is scoring low.
 * Pull: ticket header, messages, playbook state, all analyses + their
 * issues/action_items, so we can see exactly what the grader is dinging.
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
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const TICKET_ID = "0f640d41-6fa7-43a9-a20e-fae643c6dae3";

async function main() {
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, subject, channel, status, active_playbook_id, playbook_step, playbook_context, tags, ai_turn_count, escalation_reason, created_at")
    .eq("id", TICKET_ID)
    .single();
  console.log("=== TICKET ===");
  console.log(JSON.stringify(ticket, null, 2));

  if (ticket?.active_playbook_id) {
    const { data: pb } = await admin.from("playbooks").select("name").eq("id", ticket.active_playbook_id).single();
    console.log(`\nActive playbook: ${pb?.name}`);
  }

  const { data: msgs } = await admin
    .from("ticket_messages")
    .select("direction, visibility, author_type, body_clean, body, created_at")
    .eq("ticket_id", TICKET_ID)
    .order("created_at", { ascending: true });
  console.log(`\n=== MESSAGES (${msgs?.length || 0}) ===`);
  for (const m of msgs || []) {
    const body = (m.body_clean || m.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
    console.log(`\n[${m.created_at.slice(0, 19)}] ${m.direction}/${m.visibility} (${m.author_type})`);
    console.log("  " + body);
  }

  // All analyses on this ticket
  const { data: analyses } = await admin
    .from("ticket_analyses")
    .select("id, score, admin_score, issues, action_items, summary, created_at, message_window_end")
    .eq("ticket_id", TICKET_ID)
    .order("created_at", { ascending: true });

  console.log(`\n\n=== ANALYSES (${analyses?.length || 0}) ===`);
  for (const a of analyses || []) {
    console.log(`\n--- ${a.created_at.slice(0, 19)} ---`);
    console.log(`Score: ${a.score}${a.admin_score != null ? ` (admin override: ${a.admin_score})` : ""}`);
    console.log(`Summary: ${a.summary || "(none)"}`);
    if (Array.isArray(a.issues) && a.issues.length) {
      console.log("Issues:");
      for (const i of a.issues) console.log(`  - [${(i as { type: string }).type}] ${(i as { description: string }).description}`);
    }
    if (Array.isArray(a.action_items) && a.action_items.length) {
      console.log("Action items:");
      for (const i of a.action_items) console.log(`  - [${(i as { priority: string }).priority}] ${(i as { description: string }).description}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
