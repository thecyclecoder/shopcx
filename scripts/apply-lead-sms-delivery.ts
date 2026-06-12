import { readFileSync } from "fs"; import { resolve } from "path"; import { Client } from "pg";
const envPath="/Users/admin/Projects/shopcx/.env.local";
for(const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}
const password=process.env.SUPABASE_DB_PASSWORD!;
const host=process.env.SUPABASE_DB_HOST||"aws-1-us-east-1.pooler.supabase.com";
const cs=`postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@${host}:6543/postgres`;
const sql=readFileSync(resolve(__dirname,"../supabase/migrations/20260612120000_lead_sms_delivery.sql"),"utf8");
(async()=>{const c=new Client({connectionString:cs});await c.connect();try{await c.query(sql);console.log("✓ Applied 20260612120000_lead_sms_delivery.sql");}finally{await c.end();}})().catch(e=>{console.error(e);process.exit(1);});
