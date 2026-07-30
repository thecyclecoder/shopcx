import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  // 1. Mixed Berry restock date → 2026-07-29 (per Dylan)
  const { data: before } = await db.from("crisis_events").select("id,expected_restock_date").not("expected_restock_date","is",null);
  const { data: upd, error: uErr } = await db.from("crisis_events").update({ expected_restock_date: "2026-07-29", updated_at: new Date().toISOString() }).eq("expected_restock_date","2026-07-30").select("id,expected_restock_date");
  console.log("1) crisis restock date:", uErr ? "ERR "+uErr.message : `updated ${(upd||[]).length} row(s) → 2026-07-29 (was 7/30)`);

  // 3. Turn off the assisted-purchase playbooks (all workspaces)
  const { data: pbOff, error: pErr } = await db.from("playbooks").update({ is_active: false, updated_at: new Date().toISOString() }).in("name",["Assisted Order Purchase","Assisted Subscription Purchase"]).eq("is_active",true).select("name,workspace_id");
  console.log("3) playbooks deactivated:", pErr ? "ERR "+pErr.message : `${(pbOff||[]).length} row(s) → is_active=false`);
  // verify none active
  const { data: stillOn } = await db.from("playbooks").select("name").in("name",["Assisted Order Purchase","Assisted Subscription Purchase"]).eq("is_active",true);
  console.log("   still active:", (stillOn||[]).length);
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
