import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const s = await getSpec(WS, "competitor-sdk-chokepoint-and-per-product-cleanup");
  if (!s) return console.log("NOT FOUND");
  console.log("status:", s.status, "| owner:", s.owner, "| auto_build:", (s as any).auto_build);
  console.log("parent:", (s as any).parent_ref ?? (s as any).parent);
  console.log("phases:", (s.phases ?? []).map((p: any) => `${p.title} [${(p.checks?.length ?? 0)} checks]`).join("\n  "));
})().then(() => process.exit(0));
