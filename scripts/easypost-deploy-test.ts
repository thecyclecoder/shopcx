/**
 * Hit our deployed /api/webhooks/easypost endpoint with a synthetic
 * signed request using the NEW secret + V2 algorithm. Confirms:
 *   1. Deploy of 7f048ea is live (verification logic accepts our format)
 *   2. The newly rotated secret matches in our DB
 */
import { createClient } from "@supabase/supabase-js";
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

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const URL = "https://shopcx.ai/api/webhooks/easypost";

async function main() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: ws } = await admin.from("workspaces").select("easypost_webhook_secret").eq("id", W).single();
  const { decrypt } = await import("../src/lib/crypto");
  const secret = decrypt(ws!.easypost_webhook_secret);

  // Synthetic body — non-tracker so we exit early in our handler after passing HMAC
  const body = JSON.stringify({
    description: "ping",
    mode: "production",
    result: { id: "synthetic-test-from-claude" },
    created_at: new Date().toISOString(),
  });
  const ts = new Date().toUTCString().replace("GMT", "+0000");

  const v1 = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const v2 = crypto.createHmac("sha256", secret).update(ts + body).digest("hex");

  console.log(`Sending synthetic request to ${URL}`);
  console.log(`  body length: ${body.length}`);
  console.log(`  V1 sig: ${v1}`);
  console.log(`  V2 sig: ${v2}`);

  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hmac-Signature": `hmac-sha256-hex=${v1}`,
      "X-Hmac-Signature-V2": `hmac-sha256-hex=${v2}`,
      "X-Timestamp": ts,
    },
    body,
  });
  const text = await res.text();
  console.log(`\nResponse: HTTP ${res.status}`);
  console.log(`  body: ${text.slice(0, 300)}`);

  if (res.status === 200) {
    console.log("\n✅ Deploy is live, verification works with the new secret. Real EasyPost events will pass once they're signed with the new secret (any fresh event after the rotation).");
  } else if (res.status === 401) {
    console.log("\n⚠ Still 401 — either the deploy hasn't finished OR our handler logic still has a bug.");
  } else {
    console.log(`\n? Unexpected status ${res.status}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
