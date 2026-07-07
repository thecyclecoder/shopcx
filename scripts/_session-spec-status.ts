import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS=[
  "add-payment-method-journey","assisted-purchase-playbook",
  "human-directives-hard-gates-over-ticket-ai","ticket-merge-summary-and-context-cap",
  "replacement-address-uses-current-canonical-not-stale-order",
  "refund-idempotency-guard-in-commerce-refund-facade",
  "backfill-order-refunds-ledger-from-history","ci-guard-table-refs-have-migrations",
  "clarification-turns-send-full-message-not-bare-question",
  "ci-guard-migrations-applied-not-just-merged",
  "builder-migration-apply-uses-working-pgclient-not-broken-db-push",
];
(async () => {
  for(const slug of SLUGS){
    const s = await getSpec(WS, slug);
    if(!s){console.log("✗ MISSING:", slug);continue;}
    const phases=(s.phases||[]);
    const done=phases.filter((p:any)=>p.status==="shipped"||p.status==="folded").length;
    const st=(s as any).status;
    console.log(`${slug.slice(0,50).padEnd(50)} status=${st||"derived"} phases=${done}/${phases.length} ${phases.map((p:any)=>p.status[0]).join("")}`);
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
