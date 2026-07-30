import { loadEnv } from "./_bootstrap"; loadEnv();
import { pgQuery } from "../src/lib/pg-pool";
(async()=>{
  const rows=await pgQuery<{def:string}>(`SELECT pg_get_functiondef('public.claim_agent_job(text[])'::regprocedure) AS def`);
  const def=rows?.[0]?.def||"";
  console.log("has cooldown predicate:", /claimed_at is null or claimed_at <= now\(\)/i.test(def) || /claimed_at IS NULL OR claimed_at <= now\(\)/i.test(def));
  console.log("has kill-switch enforce (node/ancestor):", /ancestor|kill_switch/i.test(def));
  console.log("--- def length:", def.length, "chars ---");
  // print the WHERE clause region
  const m=def.match(/where[\s\S]{0,400}/i);
  console.log("WHERE region:\n", m?.[0]?.slice(0,500));
})().then(()=>process.exit(0));
