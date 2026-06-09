// Usage: npx tsx scripts/gen-payment-recovery-link.ts <email>
import { readFileSync, existsSync } from "node:fs"; import { resolve } from "node:path";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const email = process.argv[2] || "dylanralston@gmail.com";
(async()=>{
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { generatePaymentRecoveryLink } = await import("../src/lib/magic-link");
  const admin = createAdminClient();
  const { data: c } = await admin.from("customers").select("id,shopify_customer_id,email").eq("workspace_id",WS).eq("email",email).single();
  if(!c){console.log("no customer for",email);return;}
  const url = await generatePaymentRecoveryLink(c.id, c.shopify_customer_id||"", c.email, WS);
  console.log(`\nRecovery link for ${email}:\n${url}\n`);
}
)().catch(e=>console.error("ERR:",e.message));
