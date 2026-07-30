import { loadEnv } from "./_bootstrap"; loadEnv();
import { Client } from "pg";
(async()=>{
  const pw=process.env.SUPABASE_DB_PASSWORD;
  if(!pw){ console.log("no SUPABASE_DB_PASSWORD"); return; }
  const c=new Client({ connectionString:`postgres://postgres.urjbhjbygyxffrfkarqn:${pw}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`, ssl:{rejectUnauthorized:false} });
  await c.connect();
  // 1) total public tables + RLS on/off
  const tot=await c.query(`select count(*)::int n, count(*) filter (where c.relrowsecurity) as rls_on from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`);
  console.log(`public tables: ${tot.rows[0].n} · RLS on: ${tot.rows[0].rls_on} · RLS OFF: ${tot.rows[0].n - tot.rows[0].rls_on}`);
  // 2) RLS-OFF tables that ALSO grant SELECT to anon/authenticated = actually world-reachable
  const exposed=await c.query(`
    select c.relname,
           has_table_privilege('anon', ('public.'||c.relname)::regclass, 'SELECT') as anon_sel,
           has_table_privilege('authenticated', ('public.'||c.relname)::regclass, 'SELECT') as auth_sel
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relrowsecurity=false
    order by c.relname`);
  const anonReadable=exposed.rows.filter((r:any)=>r.anon_sel);
  console.log(`\nRLS-OFF tables anon can SELECT (WORLD-READABLE): ${anonReadable.length}`);
  for(const r of anonReadable.slice(0,60)) console.log(`  ✗ ${r.relname}`);
  // 3) RLS-off but NOT anon-readable (grants revoked → safe despite no RLS)
  const rlsOffSafe=exposed.rows.filter((r:any)=>!r.anon_sel);
  console.log(`\nRLS-OFF but anon CANNOT select (safe — no grant): ${rlsOffSafe.length}`);
  await c.end();
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,300));process.exit(1);});
