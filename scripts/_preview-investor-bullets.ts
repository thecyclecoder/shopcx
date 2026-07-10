import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { buildInvestorPerformance, renderInvestorEmailHtml } from "../src/lib/investor-update";
import * as fs from "fs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BUILDING=[
  "We've built AI that produces our ad creative end to end — the product photography, the before/after imagery, and the offer itself — so we can test far more angles and keep bringing the cost of each new customer down.",
  "Customer support now runs on AI that resolves the everyday questions instantly and only pulls in a person for the judgment calls (like refunds), which keeps subscribers happy and subscribed without adding headcount.",
  "We connected our real accounting books straight into this live dashboard — the very charts in this email — so every number is the actual number, and we're extending it into a full company scoreboard.",
];
async function main(){
  const admin=createAdminClient();
  const perf=await buildInvestorPerformance(WS,admin); if(!perf)return;
  perf.building=BUILDING;
  console.log("WHAT'S WORKING:");
  perf.working.forEach(b=>console.log("  ▲",b));
  console.log("\nWHAT NEEDS HELP:");
  perf.needsHelp.forEach(b=>console.log("  ◆",b));
  console.log("\nWHAT WE'RE DOING:");
  perf.building.forEach(b=>console.log("  →",b));
  const html=renderInvestorEmailHtml({firstName:"Dylan",link:"https://shopcx.ai/investors/enter?token=PREVIEW",perf});
  fs.writeFileSync(process.env.HOME+"/Desktop/investor-email-preview.html",html);
  console.log("\nWrote email preview → ~/Desktop/investor-email-preview.html");
}
main().catch(e=>{console.error(e);process.exit(1);});
