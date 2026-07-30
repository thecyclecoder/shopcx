import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const s:any=await getSpec(WS,"control-tower-fraud-detector-workprobe-exclude-internal-rene").catch(()=>null);
  console.log("prior fraud spec owner:", s?.owner ?? "unknown");
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,120));process.exit(1);});
