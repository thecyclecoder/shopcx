/**
 * Test the new HMAC verification against a real captured payload from
 * EasyPost so we know the fix works BEFORE deploying.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import crypto from "crypto";

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

async function main() {
  const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: ws } = await admin.from("workspaces").select("easypost_webhook_secret, easypost_live_api_key_encrypted").eq("id", W).single();
  const { decrypt } = await import("../src/lib/crypto");
  const secret = decrypt(ws!.easypost_webhook_secret);
  const key = decrypt(ws!.easypost_live_api_key_encrypted);
  const auth = "Basic " + Buffer.from(key + ":").toString("base64");

  // Pull the most recent failed event's payload — get the request body + headers
  const evRes = await fetch("https://api.easypost.com/v2/events?page_size=5", { headers: { Authorization: auth } });
  const events = (await evRes.json()).events as { id: string; description: string }[];

  for (const ev of events) {
    const plRes = await fetch(`https://api.easypost.com/v2/events/${ev.id}/payloads`, { headers: { Authorization: auth } });
    const payloads = (await plRes.json()).payloads as { id: string }[];
    if (!payloads.length) continue;
    const pl = await (await fetch(`https://api.easypost.com/v2/events/${ev.id}/payloads/${payloads[0].id}`, { headers: { Authorization: auth } })).json();

    const reqHeaders = pl.request_headers as Record<string, string>;
    const reqBody = pl.request_body as string;
    const v1 = reqHeaders["X-Hmac-Signature"]?.replace(/^hmac-sha256-hex=/i, "").trim();
    const v2 = reqHeaders["X-Hmac-Signature-V2"]?.replace(/^hmac-sha256-hex=/i, "").trim();
    const ts = reqHeaders["X-Timestamp"];

    console.log(`\nEvent ${ev.id}  ${ev.description}`);
    console.log(`  body (${reqBody.length} chars): ${reqBody.slice(0, 100)}…`);
    console.log(`  V1 sig:    ${v1}`);
    console.log(`  V2 sig:    ${v2}`);
    console.log(`  timestamp: ${ts}`);

    const expectedV1 = crypto.createHmac("sha256", secret).update(reqBody).digest("hex");
    const expectedV2 = ts ? crypto.createHmac("sha256", secret).update(ts + reqBody).digest("hex") : null;
    console.log(`  Expected V1 (body only):       ${expectedV1}`);
    console.log(`  Expected V2 (ts + body):       ${expectedV2}`);
    console.log(`  V1 match: ${v1 === expectedV1 ? "✓" : "✗"}`);
    console.log(`  V2 match: ${v2 === expectedV2 ? "✓" : "✗"}`);

    // Try a few alternative hashings if neither matched
    if (v1 !== expectedV1 && v2 !== expectedV2) {
      const altA = crypto.createHmac("sha256", secret).update(`${reqBody}`).digest("hex"); // body only (same as V1)
      const altB = ts ? crypto.createHmac("sha256", secret).update(`${ts}.${reqBody}`).digest("hex") : null; // dot separator
      const altC = ts ? crypto.createHmac("sha256", secret).update(`${ts}\n${reqBody}`).digest("hex") : null; // newline
      console.log(`  alt body-only:        ${altA} → ${altA === v1 || altA === v2}`);
      console.log(`  alt ts.body (dot):    ${altB} → ${altB === v1 || altB === v2}`);
      console.log(`  alt ts\\nbody (newline): ${altC} → ${altC === v1 || altC === v2}`);
    }
    break; // just need one
  }
}

main().catch(e => { console.error(e); process.exit(1); });
