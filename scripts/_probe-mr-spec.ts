import { loadEnv } from "./_bootstrap";
loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS = process.env.SHOPCX_WORKSPACE_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const s = await getSpec(WS, "every-spec-writer-authors-machine-runnable-verifications");
  if (!s) { console.log("NOT FOUND"); return; }
  console.log("status:", s.status, "| owner:", (s as any).owner ?? (s as any).owner_function, "| parentKind:", (s as any).parent_kind, "| parentRef:", (s as any).parent_ref);
  console.log("title:", s.title);
  console.log("=== PHASES ===");
  for (const p of ((s as any).phases || [])) {
    console.log(`\n[P${p.position}] ${p.title}  <${p.status}>`);
    console.log((p.body || "").slice(0, 700));
  }
})().catch(e => console.error("ERR", e?.message || String(e)));
