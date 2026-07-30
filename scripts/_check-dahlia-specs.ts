import { loadEnv } from "./_bootstrap";
loadEnv();
import { listSpecs } from "../src/lib/specs-table";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS = [
 "dahlia-conversion-psychology-rubric-module","dahlia-audience-temperature-marking-and-cold-offer-gate",
 "dahlia-copy-author-box-session","dahlia-max-independent-copy-qc-box-session","dahlia-five-frameworks-copy-skill",
 "dahlia-never-fabricate-copy-firewall","dahlia-preserve-competitor-copy-dna-debranded","dahlia-shared-deterministic-copy-validator",
 "max-copy-qc-scroll-stop-dims","dahlia-market-sophistication-escalation","dahlia-cold-graded-inline-link-ctr-leading-signal",
 "dahlia-andromeda-concept-diversity-tags","dahlia-temperature-banded-multi-variant-copy-pack",
 "dahlia-publisher-asset-feed-spec-upgrade-and-competitor-selection"];
function roll(phases:any[]){ if(!phases?.length) return "no-phases";
  const s = phases.map(p=>p.status);
  if (s.every(x=>x==="shipped")) return "all-shipped";
  if (s.some(x=>x==="in progress"||x==="in_progress")) return "in-progress";
  return s.join("/"); }
async function main(){
  const specs = await listSpecs(WS);
  const bySlug = new Map(specs.map((s:any)=>[s.slug,s]));
  console.log("status         intended       auto  defer  vale_pass  phases");
  for (const slug of SLUGS){
    const s:any = bySlug.get(slug);
    if (!s){ console.log(`MISSING ${slug}`); continue; }
    console.log(
      `${String(s.status).padEnd(14)} ${String(s.intended_status).padEnd(14)} `+
      `${String(s.auto_build).padEnd(5)} ${String(s.deferred).padEnd(6)} ${String(s.vale_pass).padEnd(10)} `+
      `${roll(s.phases)}  ${slug}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
