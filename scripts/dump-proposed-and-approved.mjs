import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const { data: rows, error } = await sb.from("sonnet_prompts").select("id, title, content, category, status, enabled").eq("workspace_id", W).order("status", { ascending: true });
if (error) { console.error(error); process.exit(1); }

const proposed = rows.filter(r => r.status === "proposed");
const approved = rows.filter(r => r.status === "approved");

let out = `# PROPOSED RULES (${proposed.length})\n\n`;
for (const r of proposed) {
  out += `\n---\n## [${r.id}] ${r.title}\n\n${r.content}\n`;
}
out += `\n\n\n# APPROVED RULES — TITLES ONLY (${approved.length})\n\n`;
for (const r of approved) out += `- [${r.id}] ${r.title}\n`;

writeFileSync("/tmp/proposed-rules-dump.md", out);
console.log("Wrote /tmp/proposed-rules-dump.md");
console.log(`Proposed: ${proposed.length}, Approved: ${approved.length}`);

// Also dump full approved rules for searching
let approvedFull = `# APPROVED RULES FULL (${approved.length})\n\n`;
for (const r of approved) {
  approvedFull += `\n---\n## [${r.id}] ${r.title}\n\n${r.content}\n`;
}
writeFileSync("/tmp/approved-rules-full.md", approvedFull);
console.log("Wrote /tmp/approved-rules-full.md");
