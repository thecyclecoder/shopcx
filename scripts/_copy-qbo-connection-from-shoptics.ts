/**
 * Copy shoptics' live QBO connection (refresh_token + realm_id + app client_id/secret) into shopcx's
 * quickbooks_connections for the Superfoods workspace, AES-256-GCM encrypted via src/lib/crypto.ts.
 * This is the shoptics→shopcx finance handoff: shopcx becomes the QBO owner (CFO / Grace).
 *
 * Reads shoptics' OWN Supabase (shoptics/.env.local NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY);
 * writes shopcx's Supabase (this repo's env via _bootstrap).
 *
 * Run: npx tsx scripts/_copy-qbo-connection-from-shoptics.ts
 */
import { loadEnv } from "./_bootstrap"; loadEnv();
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase/admin";
import { encrypt } from "../src/lib/crypto";

const SUPERFOODS_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  // shoptics DB (its own project)
  const senv: Record<string, string> = {};
  for (const line of readFileSync("/Users/admin/Projects/shoptics/.env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) senv[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const shoptics = createClient(senv.NEXT_PUBLIC_SUPABASE_URL, senv.SUPABASE_SERVICE_ROLE_KEY);

  const { data: tok, error: te } = await shoptics.from("qb_tokens").select("refresh_token, realm_id").eq("id", "current").single();
  if (te || !tok?.refresh_token) throw new Error(`shoptics qb_tokens read failed: ${te?.message ?? "no token"}`);
  const { data: credRow, error: ce } = await shoptics.from("integration_credentials").select("credentials").eq("id", "quickbooks").single();
  if (ce || !credRow) throw new Error(`shoptics credentials read failed: ${ce?.message ?? "none"}`);
  const creds = credRow.credentials as Record<string, string>;

  console.log("source: realm_id", tok.realm_id, "| env", creds.environment, "| client_id", creds.client_id?.slice(0, 8) + "…");

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const { error } = await admin.from("quickbooks_connections").upsert(
    {
      workspace_id: SUPERFOODS_WORKSPACE_ID,
      realm_id: tok.realm_id,
      environment: creds.environment ?? "production",
      refresh_token_encrypted: encrypt(tok.refresh_token),
      client_id_encrypted: encrypt(creds.client_id),
      client_secret_encrypted: encrypt(creds.client_secret),
      connected_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: "workspace_id" },
  );
  if (error) throw new Error(`shopcx quickbooks_connections upsert: ${error.message}`);
  console.log("✓ copied QBO connection into shopcx quickbooks_connections for Superfoods");
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exit(1); });
