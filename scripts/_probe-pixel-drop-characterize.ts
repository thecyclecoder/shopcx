import { readFileSync } from "fs"; import { resolve } from "path"; import { Client } from "pg";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}
const password=process.env.SUPABASE_DB_PASSWORD!;const host=process.env.SUPABASE_DB_HOST||"aws-1-us-east-1.pooler.supabase.com";
const cs=`postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@${host}:6543/postgres`;
const W=`(timestamp '2026-06-24 00:00' AT TIME ZONE 'America/Chicago')`;
const REAL=`NOT s.is_internal AND NOT s.is_bot AND (s.customer_id IS NULL OR s.customer_id NOT IN (SELECT id FROM customers WHERE is_internal))`;
(async()=>{const c=new Client({connectionString:cs});await c.connect();

// pdp_view drop rate by bucket (lander vs bare PDP), 7d real
for (const [name,cond] of [["LANDER (variant present)","s.landing_url ~ '[?&]variant='"],["BARE PDP (no variant)","s.landing_url !~ '[?&]variant=' AND s.landing_url ~ '/amazing-coffee'"]] as const){
  const r=await c.query(`
   WITH sess AS (SELECT s.id FROM storefront_sessions s WHERE s.last_seen_at >= ${W} AND ${REAL} AND ${cond})
   SELECT count(*) AS sessions,
     count(*) FILTER (WHERE id IN (SELECT session_id FROM storefront_events WHERE event_type='pdp_view')) AS fired_pdp_view,
     count(*) FILTER (WHERE id NOT IN (SELECT session_id FROM storefront_events WHERE event_type='pdp_view')) AS missing_pdp_view
   FROM sess`);
  const row=r.rows[0];
  const pctMiss=(100*Number(row.missing_pdp_view)/Math.max(1,Number(row.sessions))).toFixed(1);
  console.log(`${name}: sessions=${row.sessions} fired=${row.fired_pdp_view} MISSING=${row.missing_pdp_view} (${pctMiss}%)`);
}

// event volume for sizing the #2 implementation
const vol=await c.query(`
 SELECT
  (SELECT count(*) FROM storefront_events WHERE created_at >= now()-interval '7 days') AS events_7d,
  (SELECT count(*) FROM storefront_events WHERE created_at >= now()-interval '30 days') AS events_30d,
  (SELECT count(DISTINCT session_id) FROM storefront_events WHERE created_at >= now()-interval '30 days') AS distinct_sessions_30d`);
console.log("\nEVENT VOLUME:");console.table(vol.rows);
await c.end();})().catch(e=>{console.error(e);process.exit(1);});
