/**
 * Pull recent EasyPost events and check their delivery status to our
 * webhook. EasyPost retries failed deliveries — if they're failing,
 * the delivery_attempts will show non-200 responses or skipped status.
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

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TARGET_TRACKER = "trk_70c9eefb3928477691c790126be9dcf6"; // April's tracker

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data: ws } = await admin
    .from("workspaces")
    .select("easypost_live_api_key_encrypted")
    .eq("id", W)
    .single();
  const { decrypt } = await import("../src/lib/crypto");
  const key = decrypt(ws!.easypost_live_api_key_encrypted);
  const auth = "Basic " + Buffer.from(key + ":").toString("base64");

  // List recent events
  console.log(`──── Recent EasyPost events (last 20) ────\n`);
  const res = await fetch("https://api.easypost.com/v2/events?page_size=20", { headers: { Authorization: auth } });
  if (!res.ok) { console.error(res.status, await res.text()); return; }
  const data = await res.json();
  const events = (data.events || []) as { id: string; description: string; created_at: string; updated_at: string; mode: string; status: string; status_detail: string; result: { tracking_code?: string; status?: string; id?: string } }[];

  console.log(`${events.length} event(s):\n`);
  for (const e of events) {
    const trk = (e.result as { id?: string })?.id;
    const trkStatus = (e.result as { status?: string })?.status;
    console.log(`  ${e.created_at}  ${e.description}  mode=${e.mode}`);
    console.log(`    delivery: ${e.status}${e.status_detail ? "/" + e.status_detail : ""}`);
    console.log(`    tracker: ${trk || "—"}  status: ${trkStatus || "—"}`);
    console.log(`    event id: ${e.id}`);
  }

  // Check specifically for events on April's tracker
  console.log(`\n──── Events for April's tracker (${TARGET_TRACKER}) ────\n`);
  const aprilEvents = events.filter(e => (e.result as { id?: string })?.id === TARGET_TRACKER);
  console.log(`  ${aprilEvents.length} match(es) in the last 20 events`);
  for (const e of aprilEvents) {
    console.log(`  ${e.created_at}  ${e.description}  status=${e.status} detail=${e.status_detail}`);
    // Get delivery attempts on this specific event
    const detRes = await fetch(`https://api.easypost.com/v2/events/${e.id}/payloads`, { headers: { Authorization: auth } });
    if (detRes.ok) {
      const detData = await detRes.json();
      const payloads = (detData.payloads || []) as { id: string; created_at: string; response_code: number; webhook_url: string; total_url_parameters: number }[];
      console.log(`    ${payloads.length} delivery attempt(s):`);
      for (const p of payloads) {
        console.log(`      ${p.created_at}  url=${p.webhook_url}  → HTTP ${p.response_code}`);
      }
    }
  }

  // Try to look up events specifically for April's tracker if none in the last 20
  if (aprilEvents.length === 0) {
    console.log("\n  (none in last 20 events — try going further back)");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
