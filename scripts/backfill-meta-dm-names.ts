/**
 * Backfill sender names + customer matches on existing Meta DM
 * tickets. The webhook now enriches on insert; this script does the
 * same for tickets that were created before the enrichment landed.
 *
 * Idempotent — re-running is safe (skips tickets whose subject
 * already contains a name).
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

async function main() {
  const { data: tickets } = await admin
    .from("tickets")
    .select("id, subject, meta_sender_id, customer_id")
    .eq("workspace_id", WS)
    .eq("channel", "meta_dm");
  if (!tickets?.length) { console.log("no meta_dm tickets"); return; }

  const { data: ws } = await admin
    .from("workspaces")
    .select("meta_page_access_token_encrypted")
    .eq("id", WS).single();
  if (!ws?.meta_page_access_token_encrypted) { console.log("no meta token"); return; }
  const { decrypt } = await import("../src/lib/crypto");
  const { fetchMessengerUserProfile } = await import("../src/lib/meta");
  const token = decrypt(ws.meta_page_access_token_encrypted);

  for (const t of tickets) {
    if (!t.meta_sender_id) continue;
    if (t.subject && !/^DM from \d+$/.test(t.subject)) {
      console.log(`skip ${t.id} (already named: "${t.subject}")`);
      continue;
    }
    const profile = await fetchMessengerUserProfile(token, t.meta_sender_id);
    if (!profile) {
      console.log(`✗ ${t.id} ${t.meta_sender_id} — profile fetch failed`);
      continue;
    }
    const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
    if (!fullName) {
      console.log(`✗ ${t.id} ${t.meta_sender_id} — empty name`);
      continue;
    }
    const updates: Record<string, unknown> = { subject: `DM from ${fullName}` };
    if (!t.customer_id && profile.first_name && profile.last_name) {
      const { data: matches } = await admin
        .from("customers").select("id")
        .eq("workspace_id", WS)
        .ilike("first_name", profile.first_name)
        .ilike("last_name", profile.last_name)
        .limit(2);
      if (matches && matches.length === 1) {
        updates.customer_id = matches[0].id;
        console.log(`  → matched customer ${matches[0].id}`);
      }
    }
    await admin.from("tickets").update(updates).eq("id", t.id);
    console.log(`✓ ${t.id} → ${fullName}${updates.customer_id ? " (matched)" : ""}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
