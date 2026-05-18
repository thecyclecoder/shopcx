/**
 * Backfill customers.short_code for SMS subscribers that are missing one.
 *
 * Non-subscribers are skipped — their codes get assigned lazily when (a) a
 * new customer row is inserted (the BEFORE INSERT trigger handles this) or
 * (b) they later subscribe to SMS marketing.
 *
 * Run: node scripts/backfill-customer-short-codes.mjs [--apply] [--workspace=<uuid>] [--all]
 *   --all  → backfill every customer regardless of SMS status
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const APPLY = process.argv.includes("--apply");
const ALL_CUSTOMERS = process.argv.includes("--all");
const wsArg = process.argv.find(a => a.startsWith("--workspace="));
const WORKSPACE = wsArg ? wsArg.split("=")[1] : null;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function gen(n = 5) {
  let s = "";
  for (let i = 0; i < n; i++) s += CROCKFORD[Math.floor(Math.random() * 32)];
  return s;
}

// Count first
let countQ = sb.from("customers").select("id", { count: "exact", head: true }).is("short_code", null);
if (WORKSPACE) countQ = countQ.eq("workspace_id", WORKSPACE);
if (!ALL_CUSTOMERS) countQ = countQ.eq("sms_marketing_status", "subscribed");
const { count: missing } = await countQ;
const filterDesc = ALL_CUSTOMERS ? "all customers" : "SMS subscribers";
console.log(`${filterDesc} missing short_code: ${missing || 0}${WORKSPACE ? ` (workspace ${WORKSPACE})` : ""}`);
if (!APPLY) { console.log("(dry run — pass --apply to assign)"); process.exit(0); }
if (!missing) process.exit(0);

const PAGE = 1000;
const PARALLEL = 50;
let totalUpdated = 0, totalCollisions = 0;
const t0 = Date.now();

async function assignOne(id) {
  let attempts = 0;
  let netRetries = 0;
  while (attempts < 50) {
    const code = gen(5);
    let resp;
    try {
      resp = await sb.from("customers")
        .update({ short_code: code, updated_at: new Date().toISOString() })
        .eq("id", id)
        .is("short_code", null);
    } catch (err) {
      // Transient network errors — back off and retry the same code.
      if (netRetries >= 5) return { ok: false, err: `network: ${err}` };
      netRetries++;
      await new Promise(r => setTimeout(r, 500 * netRetries));
      continue;
    }
    if (!resp.error) return { ok: true, attempts };
    if (resp.error.code === "23505" || /duplicate|unique/i.test(resp.error.message)) {
      attempts++; continue;
    }
    return { ok: false, err: resp.error.message };
  }
  return { ok: false, err: "50 attempts exceeded" };
}

while (true) {
  let q = sb.from("customers").select("id").is("short_code", null).limit(PAGE);
  if (WORKSPACE) q = q.eq("workspace_id", WORKSPACE);
  if (!ALL_CUSTOMERS) q = q.eq("sms_marketing_status", "subscribed");
  const { data: batch, error } = await q;
  if (error) { console.error(error); process.exit(1); }
  if (!batch || batch.length === 0) break;

  // Process the batch in waves of PARALLEL concurrent updates.
  for (let i = 0; i < batch.length; i += PARALLEL) {
    const wave = batch.slice(i, i + PARALLEL);
    const results = await Promise.all(wave.map(c => assignOne(c.id)));
    for (const r of results) {
      if (r.ok) { totalUpdated++; totalCollisions += r.attempts; }
      else { console.error("Update failed (skipping):", r.err); }
    }
  }

  const dt = (Date.now() - t0) / 1000;
  const rate = totalUpdated / dt;
  const remaining = (missing - totalUpdated);
  const eta = remaining / rate;
  console.log(`  ${totalUpdated.toLocaleString()} / ${missing.toLocaleString()} (${rate.toFixed(0)}/sec, ETA ${(eta / 60).toFixed(1)}m, collisions ${totalCollisions})`);

  if (batch.length < PAGE) break;
}
console.log(`Done. Updated ${totalUpdated}. Collisions retried: ${totalCollisions}. Took ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
