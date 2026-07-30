import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";

const V = "v21.0";
async function g(path: string, token: string, params: Record<string,string> = {}) {
  const u = new URL(`https://graph.facebook.com/${V}/${path}`);
  for (const [k,v] of Object.entries(params)) u.searchParams.set(k,v);
  u.searchParams.set("access_token", token);
  const r = await fetch(u); const j = await r.json();
  if (j.error) throw new Error(`${path}: ${j.error.message}`);
  return j;
}

(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id,name").limit(20);
  for (const w of ws ?? []) {
    const token = await getMetaUserToken(w.id);
    if (!token) continue;
    console.log(`\n=== WORKSPACE: ${w.name} (${w.id}) ===`);
    const accts = await g("me/adaccounts", token, { fields: "id,name,account_status" });
    for (const a of accts.data ?? []) {
      console.log(`\n--- AD ACCOUNT: ${a.name} (${a.id}) ---`);
      const sets = await g(`${a.id}/adsets`, token, {
        fields: "id,name,status,effective_status,destination_type,optimization_goal,promoted_object,campaign{id,name,objective}",
        limit: "100",
      });
      for (const s of sets.data ?? []) {
        if (s.effective_status !== "ACTIVE") continue;
        console.log(`\n  ADSET ${s.name}`);
        console.log(`    status=${s.effective_status} destination_type=${s.destination_type ?? "(unset)"} opt=${s.optimization_goal}`);
        console.log(`    campaign=${s.campaign?.name} objective=${s.campaign?.objective}`);
        console.log(`    promoted_object=${JSON.stringify(s.promoted_object)}`);
      }
    }
  }
})();
