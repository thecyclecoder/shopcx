import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
// 6 MissingMachineCheckError repair jobs → requeue (re-author structured under #1791, now live on box)
const REDRIVE=[
  {id:"ec8a125f-ed4e-4f4f-bfc9-d9bb9685c74f", slug:"portal-subscription-items-appstle-timeout-guard"},
  {id:"14ac4d60-f667-4bea-a901-3b7b0b97db87", slug:"appstle-frequency-timeout-log-after-verification"},
  {id:"a6522e38-7c0b-45e7-a925-4c099fb6caf0", slug:"meta-adimage-upload-retry-transients"},
  {id:"534187f6-d992-4370-a9e0-1cd015b34786", slug:"internal-renewal-active-braintree-card-fallback"},
  {id:"b0c8fc67-bda0-439e-be19-c63bfa3099aa", slug:"media-buyer-replenish-publish-copy-guard"},
  {id:"03f495e0-cd12-4dc9-94d8-2bb012cc09e8", slug:"meta-static-image-creative-link-data-fix"},
];
// coverage-register for the 2h cron is superseded by spec #34 (register-media-buyer-test-cadence-monitored-loop)
const SUPERSEDE={id:"c9220a97-b552-459b-a52e-9d6244a0196c", by:"register-media-buyer-test-cadence-monitored-loop"};
(async()=>{
  const db=createAdminClient();
  for(const j of REDRIVE){
    const {error}=await db.from("agent_jobs").update({
      status:"queued", needs_attention_class:null, error:null,
      log_tail:`Manual redrive (CEO-approved 2026-07-13): MissingMachineCheckError authoring rail fixed by #1791 (live on box). Re-authoring [[${j.slug}]] structured with machine checks.`,
    }).eq("id",j.id).eq("status","needs_attention");
    console.log(error?`FAIL ${j.slug}: ${error.message}`:`✓ requeued ${j.slug}`);
  }
  const {error:e2}=await db.from("agent_jobs").update({
    status:"completed", needs_attention_class:null, error:null,
    log_tail:`Superseded by spec ${SUPERSEDE.by} (authored 2026-07-13, building) — it adds the MONITORED_LOOPS entry + heartbeat + kill-switch for media-buyer-test-cadence. Re-authoring here would duplicate it.`,
  }).eq("id",SUPERSEDE.id).eq("status","needs_attention");
  console.log(e2?`FAIL coverage: ${e2.message}`:`✓ superseded coverage-register:media-buyer-test-cadence → ${SUPERSEDE.by}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
