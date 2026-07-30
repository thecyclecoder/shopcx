import { loadEnv } from "./_bootstrap";
loadEnv();
import { resolveFunctionMandates } from "../src/lib/function-mandates";
async function main(){
  const res = await resolveFunctionMandates("platform");
  for (const m of res||[]) console.log(`platform#${m.slug}   ::  ${m.heading}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
