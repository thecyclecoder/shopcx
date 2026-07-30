import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";
const V = "v21.0";
async function g(path: string, token: string, params: Record<string,string> = {}) {
  const u = new URL(`https://graph.facebook.com/${V}/${path}`);
  for (const [k,v] of Object.entries(params)) u.searchParams.set(k,v);
  u.searchParams.set("access_token", token);
  const r = await fetch(u); const j = await r.json();
  if (j.error) return { __err: j.error.message };
  return j;
}
(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id,name").limit(20);
  let token: string | null = null;
  for (const w of ws ?? []) { token = await getMetaUserToken(w.id); if (token) break; }
  if (!token) throw new Error("no token");
  const sets = await g("act_196487894712827/adsets", token, {
    fields: "id,name,status,effective_status,destination_type", limit: "100",
  });
  const paused = (sets.data ?? []).filter((s: any) => s.effective_status === "PAUSED");
  console.log(`PAUSED adsets in Superfood Tabs: ${paused.length}`);
  for (const s of paused.slice(0, 6)) console.log(`  ${s.id}  dest=${s.destination_type}  ${s.name}`);
})();
