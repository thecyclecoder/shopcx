import { loadEnv } from "./_bootstrap"; loadEnv();
import { readFileSync } from "fs";
import { Client } from "pg";
const PROJECT_REF="urjbhjbygyxffrfkarqn", HOST="aws-1-us-east-1.pooler.supabase.com";
function cs(){ let s=process.env.SUPABASE_DB_URL||process.env.DATABASE_URL||""; if(!s){ const pw=process.env.SUPABASE_DB_PASSWORD; s=`postgres://postgres.${PROJECT_REF}:${encodeURIComponent(pw!)}@${process.env.SUPABASE_DB_HOST||HOST}:5432/postgres`; } return s.replace(":6543/",":5432/"); }
(async()=>{
  const c=new Client({connectionString:cs(),ssl:{rejectUnauthorized:false}}); await c.connect();
  try{ await c.query(readFileSync("supabase/migrations/20261022160000_creative_skeletons_winner_concept.sql","utf8")); console.log("migration applied ✅");
    const {rows}=await c.query(`select column_name from information_schema.columns where table_name='creative_skeletons' and column_name in ('winner_tier','winner_score','concept_tags') order by 1`);
    console.log("winner columns now:", rows.map((r:any)=>r.column_name).join(", "));
  } finally { await c.end(); }
})().then(()=>process.exit(0)).catch(e=>{console.error("FAILED:",e.message);process.exit(1);});
