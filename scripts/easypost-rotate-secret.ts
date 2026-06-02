/**
 * Rotate the EasyPost webhook secret. The previously stored secret
 * doesn't match what EasyPost is signing with — every webhook delivery
 * has been failing HMAC verification. We can't recover the original
 * secret from EasyPost (their API doesn't expose it), so we generate a
 * new one and update both sides.
 *
 *   1. Generate 64-char hex secret
 *   2. PUT to EasyPost /v2/webhooks/{id} with webhook_secret on each
 *      registered hook (live + test)
 *   3. Update workspaces.easypost_webhook_secret (encrypted)
 *
 *   Usage:
 *     npx tsx scripts/easypost-rotate-secret.ts          # dry run
 *     npx tsx scripts/easypost-rotate-secret.ts --apply  # do it
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

const APPLY = process.argv.includes("--apply");
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  const { data: ws } = await admin
    .from("workspaces")
    .select("easypost_live_api_key_encrypted, easypost_test_api_key_encrypted")
    .eq("id", W)
    .single();
  const { decrypt, encrypt } = await import("../src/lib/crypto");

  const newSecret = crypto.randomBytes(32).toString("hex"); // 64 hex chars
  console.log(`\nGenerated new secret: ${newSecret.slice(0, 12)}…${newSecret.slice(-4)}  (${newSecret.length} chars)\n`);

  for (const [mode, encryptedKey] of [
    ["LIVE", ws?.easypost_live_api_key_encrypted],
    ["TEST", ws?.easypost_test_api_key_encrypted],
  ] as [string, string | null][]) {
    if (!encryptedKey) { console.log(`${mode}: no key, skipping`); continue; }
    const apiKey = decrypt(encryptedKey);
    const auth = "Basic " + Buffer.from(apiKey + ":").toString("base64");

    // List hooks for this key
    const listRes = await fetch("https://api.easypost.com/v2/webhooks", { headers: { Authorization: auth } });
    if (!listRes.ok) { console.log(`${mode}: webhook list failed: ${listRes.status}`); continue; }
    const list = await listRes.json();
    const hooks = (list.webhooks || []) as { id: string; url: string; mode: string }[];
    console.log(`${mode}: ${hooks.length} hook(s)`);

    for (const h of hooks) {
      console.log(`  ${h.id}  url=${h.url}  mode=${h.mode}`);
      if (!APPLY) continue;

      const putRes = await fetch(`https://api.easypost.com/v2/webhooks/${h.id}`, {
        method: "PUT",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ webhook_secret: newSecret }),
      });
      if (!putRes.ok) {
        const t = await putRes.text();
        console.log(`    ✗ update failed: ${putRes.status} ${t.slice(0, 200)}`);
        continue;
      }
      console.log(`    ✓ EasyPost webhook secret updated`);
    }
  }

  if (APPLY) {
    const encrypted = encrypt(newSecret);
    const { error } = await admin
      .from("workspaces")
      .update({ easypost_webhook_secret: encrypted })
      .eq("id", W);
    if (error) { console.log(`✗ DB update failed: ${error.message}`); return; }
    console.log(`\n✓ workspaces.easypost_webhook_secret updated (encrypted)`);
    console.log("\n✅ Done — push the verification fix and EasyPost will start delivering successfully");
  } else {
    console.log("\n🔍 Re-run with --apply.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
