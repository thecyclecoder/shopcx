import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
import { createDecipheriv } from "crypto";
import { readFileSync } from "fs";

const ENC = process.env.ENCRYPTION_KEY || readFileSync("/Users/admin/Projects/shopcx/.env.local", "utf8").split("\n").find(l => l.startsWith("ENCRYPTION_KEY="))?.split("=")[1] || "";
function decrypt(s) {
  const [iv, tag, ct] = s.split(":");
  const k = Buffer.from(ENC, "hex");
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  return d.update(Buffer.from(ct, "hex")).toString("utf8") + d.final("utf8");
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const { data: ws } = await admin.from("workspaces").select("easypost_live_api_key_encrypted").eq("id", W).single();
const auth = "Basic " + Buffer.from(decrypt(ws.easypost_live_api_key_encrypted) + ":").toString("base64");

// Pull recent events, list ALL their payload attempts
const evRes = await fetch("https://api.easypost.com/v2/events?page_size=10", { headers: { Authorization: auth } });
const events = (await evRes.json()).events;

for (const ev of events) {
  const plRes = await fetch(`https://api.easypost.com/v2/events/${ev.id}/payloads`, { headers: { Authorization: auth } });
  const payloads = ((await plRes.json()).payloads || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
  console.log(`\n${ev.created_at}  ${ev.description}  status=${ev.status}`);
  for (const p of payloads) {
    console.log(`  ${p.created_at}  → HTTP ${p.response_code}`);
  }
}
