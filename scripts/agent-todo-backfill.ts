/**
 * agent-todo-backfill.ts — Phase 5 one-shot reasoning pass.
 *
 * Runs the To-Do reasoning pass over every currently-escalated ticket that
 * doesn't yet have an active todo group, writing the proposed todos. Confirms
 * the pipeline end-to-end on real data before the hourly schedule goes live.
 *
 *   npx tsx scripts/agent-todo-backfill.ts          # write todos
 *   npx tsx scripts/agent-todo-backfill.ts --dry     # reason only, write nothing
 *   AGENT_TODO_WORKSPACE_ID=<uuid> npx tsx scripts/agent-todo-backfill.ts
 *
 * See docs/brain/specs/agent-todo-system.md § Phase 5.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env.local before anything reads process.env.
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

import { runReasoningPass } from "../src/lib/agent-todos/reasoning";

const WORKSPACE_ID = process.env.AGENT_TODO_WORKSPACE_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const dryRun = process.argv.includes("--dry");

async function main() {
  console.log(`[backfill] workspace ${WORKSPACE_ID} · ${dryRun ? "DRY RUN" : "WRITING"}`);
  const results = await runReasoningPass({ workspaceId: WORKSPACE_ID, dryRun });

  let proposed = 0;
  let groups = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`  ✗ ${r.ticketId.slice(0, 8)} — error: ${r.error}`);
      continue;
    }
    if (r.skipped) {
      console.log(`  · ${r.ticketId.slice(0, 8)} — skipped: ${r.skipped}`);
      continue;
    }
    groups += 1;
    proposed += r.proposed.length;
    const types = r.proposed.map((t) => t.action_type).join(", ");
    console.log(`  ✓ ${r.ticketId.slice(0, 8)} — ${r.proposed.length} todo(s): ${types}${r.groupId ? ` [group ${r.groupId.slice(0, 8)}]` : ""}`);
  }

  console.log(`\n[backfill] ${results.length} tickets · ${groups} groups · ${proposed} todos ${dryRun ? "(not written)" : "written"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
