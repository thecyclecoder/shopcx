import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const env = {};
for (const line of readFileSync("/Users/admin/Projects/shoptics/.env.local", "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  env[t.slice(0, eq)] = t.slice(eq + 1);
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data, error } = await sb.from("integration_credentials").select("credentials").eq("id", "braintree").single();
if (error) { console.error(error); process.exit(1); }
console.log(JSON.stringify({
  merchant_id: data.credentials.merchant_id ? "(set, " + data.credentials.merchant_id.length + " chars)" : "(missing)",
  public_key: data.credentials.public_key ? "(set, " + data.credentials.public_key.length + " chars)" : "(missing)",
  private_key: data.credentials.private_key ? "(set, " + data.credentials.private_key.length + " chars)" : "(missing)",
  environment: data.credentials.environment,
}, null, 2));
// Stash for the seed step
import { writeFileSync } from "fs";
writeFileSync("/tmp/braintree-creds.json", JSON.stringify(data.credentials));
console.log("stashed to /tmp/braintree-creds.json");
