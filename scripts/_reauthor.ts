import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { authorSpecRowStructured } from "../src/lib/author-spec";
import util from "node:util";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="meta-structure-sync-reconciles-dropped-out-adsets-as-not-active";
async function main(){
  const a=createAdminClient();
  // delete the broken partial (phases/checks cascade or are empty)
  const {data:sp}=await a.from("specs").select("id").eq("workspace_id",WS).eq("slug",SLUG).maybeSingle() as any;
  if(sp?.id){ await a.from("spec_phase_checks").delete().eq("spec_id",sp.id).then(()=>{},()=>{}); await a.from("spec_phases").delete().eq("spec_id",sp.id); await a.from("specs").delete().eq("id",sp.id); console.log("deleted partial spec",sp.id.slice(0,8)); }
  try{
    await authorSpecRowStructured(WS,SLUG,{
      title:"Meta structure sync marks a no-longer-returned adset as not-active in the mirror",
      why:"The 2-hourly Meta structure sync upserts the adsets Meta returns for each test campaign, but Meta's default adsets list excludes archived and deleted adsets. So once an adset is archived on Meta the sync never sees it again and the mirror keeps its stale ACTIVE status, showing a dead adset as a live test forever with zero spend. A misfire on 2026-07-18 left two Superfood Tabs adsets stuck ACTIVE until they were reconciled by hand. The sync upserts what Meta returns but never reconciles what Meta dropped.",
      what:"After the sync upserts the adsets Meta returned for the campaigns it synced, mark any adset row for those campaigns that Meta no longer returns as archived, scoped strictly to the synced campaigns so it can never touch a still-live or unrelated adset.",
      summary:"src/lib/meta/performance.ts syncMetaStructure: after the meta_adsets upsert, when opts.campaignIds is set, diff the mirror's not-archived adset ids for those campaigns against the fetched ids via a pure reconcileDroppedAdsetIds helper and mark the difference effective_status=ARCHIVED. Only on a scoped sync.",
      owner:"growth",
      parent:'[[../functions/growth]] media-buyer (Bianca, under Max) mandate: the meta_adsets mirror is what Bianca and the Ad Testing report act on; it must reflect Meta including dropped adsets.',
      blocked_by:[],
      phases:[
        {title:"Phase 1 — reconcile dropped-out adsets as archived after a scoped structure sync",why:"the sync only upserts adsets Meta returns and Meta omits archived adsets from the default list, so a dropped adset keeps its stale ACTIVE mirror status and reads as a live test forever.",what:"after upserting the fetched adsets for the scoped campaigns, mark any mirror adset for those campaigns that Meta no longer returns as archived.",body:"In src/lib/meta/performance.ts syncMetaStructure, after the meta_adsets upsert and only when opts.campaignIds is non-empty, read the mirror's non-archived adset ids for those campaigns, diff against the fetched adset ids via a new pure exported reconcileDroppedAdsetIds helper, and update meta_adsets setting effective_status and status to ARCHIVED for the difference. Never reconcile on an unscoped full-account sync. Add a unit test for the pure helper. Update the meta_adsets brain page.",verification:"tsc clean; the pure helper exists and is called scoped to opts.campaignIds",checks:[{position:1,description:"tsc clean",kind:"auto",exec_kind:"tsc",params:null},{position:2,description:"reconcile helper present",kind:"auto",exec_kind:"grep",params:{pattern:"reconcileDroppedAdsetIds",path:"src/lib/meta/performance.ts",expect:"present"}}],status:"planned"},
        {title:"Phase 2 — extend the same drop-out reconcile to meta_ads",why:"a dropped or deleted ad leaves the same ghost in meta_ads, which the Ad Testing creative view reads.",what:"apply the identical scoped drop-out reconcile to meta_ads after its upsert.",body:"Mirror Phase 1 for the meta_ads upsert with a reconcileDroppedAdIds pure helper and the same opts.campaignIds scoping, marking dropped ads archived. Extend the unit test and the brain page.",verification:"tsc clean; the ads reconcile helper exists",checks:[{position:1,description:"tsc clean",kind:"auto",exec_kind:"tsc",params:null},{position:2,description:"ads reconcile helper present",kind:"auto",exec_kind:"grep",params:{pattern:"reconcileDroppedAdIds",path:"src/lib/meta/performance.ts",expect:"present"}}],status:"planned"},
      ],
    },"planned",{intendedStatusSetBy:"ceo",parentKind:"mandate",parentRef:"growth#media-buyer-bianca-under-max"});
    console.log("AUTHORED ✓");
  }catch(e:any){ console.log("RAW ERROR:", util.inspect(e,{depth:4}).slice(0,700)); }
}
main().then(()=>process.exit(0));
