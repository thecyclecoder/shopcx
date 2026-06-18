/**
 * Retag tickets that were created via the customer portal "Support"
 * sidebar from channel 'help_center' to 'portal'. Authoritative origin
 * signal: a customer_events row event_type='portal.support.ticket_created'
 * whose properties.ticket_id points at the ticket. Older help-center
 * widget/form tickets have no such event and are left untouched.
 * Idempotent.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
async function main(){
const { createAdminClient } = await import("../src/lib/supabase/admin");
const admin = createAdminClient();
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const { data: ev, error } = await admin.from("customer_events")
  .select("properties, created_at")
  .eq("workspace_id", WS)
  .eq("event_type", "portal.support.ticket_created");
if (error) throw error;
const ids = Array.from(new Set((ev||[]).map(e => (e.properties as any)?.ticket_id).filter(Boolean)));
console.log("portal-origin ticket ids:", ids.length, JSON.stringify(ids));
if (!ids.length) { console.log("nothing to retag"); return; }
const { data: toRetag } = await admin.from("tickets")
  .select("id, subject, channel, status")
  .eq("workspace_id", WS).in("id", ids).eq("channel", "help_center");
console.log("currently help_center (will retag to portal):", toRetag?.length);
for (const t of toRetag||[]) console.log(`  ${t.id} | ${t.status} | ${t.subject}`);
if (toRetag?.length) {
  const { error: upErr } = await admin.from("tickets").update({ channel: "portal" }).in("id", toRetag.map(t=>t.id));
  if (upErr) throw upErr;
  console.log("✓ retagged", toRetag.length, "tickets to channel=portal");
}
}
main().catch(e=>{console.error(e);process.exit(1);});
