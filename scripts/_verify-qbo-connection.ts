import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getQboAccessToken, getQboConnection } from "../src/lib/quickbooks";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin=createAdminClient();
  const {data}=await admin.from("quickbooks_connections")
    .select("workspace_id, realm_id, environment, updated_at, created_at, client_id_encrypted, refresh_token_encrypted")
    .eq("workspace_id",WS).maybeSingle();
  if(!data){console.log("NO connection row for shopcx workspace");return;}
  console.log("realm_id:", data.realm_id);
  console.log("environment:", data.environment);
  console.log("created_at:", data.created_at);
  console.log("updated_at:", data.updated_at, "(recent = freshly reconnected)");
  console.log("has own client_id (encrypted):", !!data.client_id_encrypted);
  console.log("has refresh token (encrypted):", !!data.refresh_token_encrypted);
  // Live test: refresh + rotate the token, confirm we get an access token
  try {
    const conn = await getQboConnection(WS, admin);
    console.log("\nrealm from getQboConnection:", conn.realmId);
    const tok = await getQboAccessToken(WS, admin);
    console.log("ACCESS TOKEN OBTAINED:", tok ? `yes (len ${tok.length})` : "no");
    console.log("→ Independent token is VALID and refreshes on our own credentials.");
  } catch(e){ console.log("TOKEN REFRESH FAILED:", e instanceof Error?e.message:String(e)); }
}
main().catch(e=>{console.error(e);process.exit(1);});
