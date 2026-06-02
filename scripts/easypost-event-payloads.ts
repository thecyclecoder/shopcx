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
// Pull payloads on the most recent FAILED event so we can see why
const EVENT_ID = process.argv[2] || "evt_54d84f0a430711f1aaa8155d9ef6a2bc";

async function main() {
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const { data: ws } = await admin.from("workspaces").select("easypost_live_api_key_encrypted").eq("id", W).single();
const { decrypt } = await import("../src/lib/crypto");
const key = decrypt(ws!.easypost_live_api_key_encrypted);
const auth = "Basic " + Buffer.from(key + ":").toString("base64");

console.log(`Payloads for event ${EVENT_ID}:\n`);

// Single event details
const evRes = await fetch(`https://api.easypost.com/v2/events/${EVENT_ID}`, { headers: { Authorization: auth } });
if (evRes.ok) {
  const ev = await evRes.json();
  console.log(`  description: ${ev.description}  status: ${ev.status} / ${ev.status_detail}`);
  const pendingUrls = ev.pending_urls || [];
  const completedUrls = ev.completed_urls || [];
  console.log(`  pending_urls:   ${JSON.stringify(pendingUrls)}`);
  console.log(`  completed_urls: ${JSON.stringify(completedUrls)}`);
}

const payloadsRes = await fetch(`https://api.easypost.com/v2/events/${EVENT_ID}/payloads`, { headers: { Authorization: auth } });
if (!payloadsRes.ok) { console.error(payloadsRes.status, await payloadsRes.text()); process.exit(1); }
const data = await payloadsRes.json();
const payloads = (data.payloads || []) as { id: string; created_at: string; webhook_url: string; response_code: number; response_headers?: Record<string, string>; total_url_parameters?: number }[];

console.log(`\n${payloads.length} delivery attempt(s):`);
for (const p of payloads) {
  console.log(`\n  ${p.created_at}`);
  console.log(`  url: ${p.webhook_url}`);
  console.log(`  HTTP ${p.response_code}`);
  if (p.response_headers) {
    console.log(`  response headers: ${JSON.stringify(p.response_headers, null, 2).slice(0, 500)}`);
  }
}

// Pull the full payload to see what they actually sent
if (payloads.length > 0) {
  const fullRes = await fetch(`https://api.easypost.com/v2/events/${EVENT_ID}/payloads/${payloads[0].id}`, {
    headers: { Authorization: auth },
  });
  if (fullRes.ok) {
    const full = await fullRes.json();
    console.log(`\nFull payload detail:`);
    console.log(`  request_url:    ${full.request_url}`);
    console.log(`  request_headers: ${JSON.stringify(full.request_headers, null, 2).slice(0, 800)}`);
    console.log(`  response_code:  ${full.response_code}`);
    console.log(`  response_headers: ${JSON.stringify(full.response_headers, null, 2).slice(0, 500)}`);
    console.log(`  response_body:  ${(full.response_body || "").slice(0, 500)}`);
  }
}
}
main().catch(e => { console.error(e); process.exit(1); });
