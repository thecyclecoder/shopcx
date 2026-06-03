/**
 * Backfill: dedupe existing customer_events rows where both a portal
 * cancel event AND an Appstle cancel event exist for the same
 * shopify_contract_id within a 5-minute window.
 *
 * Strategy: when both exist, the portal event is the richer one (carries
 * cancel reason + journey context). Delete the Appstle duplicate.
 *
 * Defaults to dry-run. Pass --apply to actually delete.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"),"utf8").split("\n")) {
  const t=line.trim(); if(!t||t.startsWith("#")) continue;
  const eq=t.indexOf("="); if(eq<0) continue;
  if(!process.env[t.slice(0,eq)]) process.env[t.slice(0,eq)]=t.slice(eq+1);
}

const APPLY = process.argv.includes("--apply");
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const WINDOW_MINUTES = 5;

async function main() {
  const pw=process.env.SUPABASE_DB_PASSWORD!;
  const cs=`postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(pw)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;
  const c=new Client({connectionString:cs});
  await c.connect();
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`Match window: ±${WINDOW_MINUTES} minutes between portal and appstle events on same contract.\n`);

  // Find duplicate Appstle cancel events: where a portal cancel
  // exists for the same customer + contract_id within WINDOW_MINUTES.
  const dupes = await c.query(`
    WITH portal AS (
      SELECT
        id, customer_id, created_at,
        (properties->>'shopify_contract_id') AS contract_id
      FROM customer_events
      WHERE workspace_id=$1::uuid
        AND source='portal'
        AND event_type='portal.subscription.cancelled'
        AND properties->>'shopify_contract_id' IS NOT NULL
    ),
    appstle AS (
      SELECT
        id, customer_id, created_at,
        (properties->>'shopify_contract_id') AS contract_id
      FROM customer_events
      WHERE workspace_id=$1::uuid
        AND source='appstle'
        AND event_type='subscription.cancelled'
        AND properties->>'shopify_contract_id' IS NOT NULL
    )
    SELECT a.id AS appstle_id, a.contract_id, a.created_at AS appstle_at, p.created_at AS portal_at
    FROM appstle a
    JOIN portal p
      ON p.customer_id = a.customer_id
      AND p.contract_id = a.contract_id
      AND ABS(EXTRACT(EPOCH FROM (a.created_at - p.created_at))) < $2::int * 60
    ORDER BY a.created_at DESC
  `, [WS, WINDOW_MINUTES]);

  console.log(`Found ${dupes.rows.length} Appstle cancel events that duplicate a portal cancel event.`);

  if (dupes.rows.length === 0) {
    await c.end();
    return;
  }

  // Show oldest + newest as a sanity check
  const newest = dupes.rows[0];
  const oldest = dupes.rows[dupes.rows.length - 1];
  console.log(`  Newest dup: contract ${newest.contract_id}  appstle=${newest.appstle_at?.toISOString?.()} portal=${newest.portal_at?.toISOString?.()}`);
  console.log(`  Oldest dup: contract ${oldest.contract_id}  appstle=${oldest.appstle_at?.toISOString?.()} portal=${oldest.portal_at?.toISOString?.()}`);

  // Bucket by month for a sense of distribution
  const byMonth = new Map<string, number>();
  for (const r of dupes.rows) {
    const month = (r.appstle_at as Date).toISOString().slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + 1);
  }
  console.log("\nDuplicates by month:");
  for (const [m, n] of [...byMonth.entries()].sort()) console.log(`  ${m}  ${n}`);

  if (!APPLY) {
    console.log(`\nDry-run only. Re-run with --apply to delete ${dupes.rows.length} Appstle duplicate rows.`);
    await c.end();
    return;
  }

  console.log(`\nDeleting ${dupes.rows.length} duplicate Appstle cancel events in batches of 500...`);
  const ids = dupes.rows.map(r => r.appstle_id as string);
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const { error, count } = await sb.from("customer_events")
      .delete({ count: "exact" })
      .in("id", batch);
    if (error) {
      console.log(`  ✗ batch ${i}: ${error.message}`);
    } else {
      deleted += count || 0;
      process.stdout.write(`  deleted ${deleted}/${ids.length}\r`);
    }
  }
  console.log(`\n  ✓ deleted ${deleted} duplicate Appstle cancel events.`);

  // Re-verify
  const after = await c.query(`
    WITH cancels AS (
      SELECT
        properties->>'shopify_contract_id' AS contract_id,
        BOOL_OR(source = 'portal') AS has_portal,
        BOOL_OR(source = 'appstle') AS has_appstle
      FROM customer_events
      WHERE workspace_id=$1::uuid
        AND event_type ILIKE '%cancel%'
        AND properties->>'shopify_contract_id' IS NOT NULL
        AND created_at > now() - interval '30 days'
      GROUP BY 1
    )
    SELECT
      COUNT(*) FILTER (WHERE has_portal AND has_appstle) AS overlap,
      COUNT(*) AS total
    FROM cancels
  `, [WS]);
  console.log(`\nLast 30d after dedup: ${after.rows[0].overlap} overlap of ${after.rows[0].total} cancellations.`);

  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1);});
