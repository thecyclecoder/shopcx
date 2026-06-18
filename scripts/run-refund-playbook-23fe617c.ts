/**
 * Ticket 23fe617c — fire the playbook-apply sentinel so the active Refund
 * playbook actually executes step 0. Replicates what the apply-playbook route
 * intends (its raw-fetch Inngest trigger never reached the handler).
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET = "23fe617c-9b97-44d9-a278-482c61a3a98e";

async function main() {
  const before = await admin.from("tickets").select("playbook_step, active_playbook_id, status").eq("id", TICKET).single();
  console.log("BEFORE:", JSON.stringify(before.data));

  const { inngest } = await import("../src/lib/inngest/client");
  const ids = await inngest.send({
    name: "ticket/inbound-message",
    data: { ticket_id: TICKET, workspace_id: WS, message_body: "playbook-apply", channel: "email", is_new_ticket: false },
  });
  console.log("fired ticket/inbound-message:", JSON.stringify(ids));
}
main().catch(e => { console.error("✗", e); process.exit(1); });
