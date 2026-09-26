/**
 * Correct approved sonnet_prompts rules that name legacy or invented ticket
 * columns (`assigned_agent`, `tickets.escalated`). The live 2026-09-26
 * PostgREST error selecting `tickets.assigned_agent` traced to an approved
 * customer-support rule; this script canonicalizes those tokens in place via
 * the same rewrite the runtime guard applies
 * (`canonicalizeTicketPolicySchemaTerms` in `src/lib/sonnet-orchestrator-v2.ts`).
 *
 * Routes each correction through the existing sonnet-prompts writer:
 *   1. `proposePrompt` — inserts the corrected content as a fresh proposal.
 *   2. `applyReviewDecision` with `finalDecision='supersede'` and
 *      `supersedeTargetId=<old>` — approves the new row.
 *   3. `archiveSupersededPrompt` — archives the old row (status='archived',
 *      enabled=false, superseded_by_id=<new>). Reversible.
 *
 * Dry-run by default. Pass `--apply` to write. Idempotent — a re-run over an
 * already-corrected DB is a no-op (the SELECT finds no matching rows).
 */
import { createAdminClient } from "./_bootstrap";
import {
  proposePrompt,
  applyReviewDecision,
  archiveSupersededPrompt,
} from "../src/lib/sonnet-prompts-table";
import { canonicalizeTicketPolicySchemaTerms } from "../src/lib/sonnet-orchestrator-v2";

const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("sonnet_prompts")
    .select("id, workspace_id, category, title, content")
    .eq("status", "approved")
    .eq("enabled", true)
    .or("content.ilike.%assigned_agent%,content.ilike.%tickets.escalated%");

  if (error) {
    console.error("select failed:", error.message);
    process.exit(1);
  }

  const rows = (data || []) as Array<{
    id: string;
    workspace_id: string;
    category: string;
    title: string;
    content: string;
  }>;

  const targets = rows
    .map((r) => ({ r, corrected: canonicalizeTicketPolicySchemaTerms(r.content) }))
    .filter((t) => t.corrected !== t.r.content);

  if (targets.length === 0) {
    console.log("no approved rules contain stale ticket-schema aliases — nothing to do");
    return;
  }

  console.log(`found ${targets.length} approved rule(s) with stale ticket-schema aliases:`);
  for (const { r } of targets) {
    console.log(`  • ${r.workspace_id}  ${r.id}  ${r.title}`);
  }

  if (!APPLY) {
    console.log("\ndry-run — re-run with --apply to correct via supersede");
    return;
  }

  for (const { r, corrected } of targets) {
    const proposed = await proposePrompt(admin, {
      workspaceId: r.workspace_id,
      title: r.title,
      content: corrected,
      category: r.category,
    });
    if (!proposed.id) {
      console.error(`  ✗ ${r.id}: propose failed — ${proposed.error}`);
      continue;
    }
    const decided = await applyReviewDecision(admin, {
      workspaceId: r.workspace_id,
      promptId: proposed.id,
      finalDecision: "supersede",
      reasoning:
        "canonicalize ticket-policy schema aliases (assigned_agent → assigned_to; tickets.escalated → tickets.escalated_at) — see docs/brain/specs/ticket-policy-schema-alias-guard.md",
      confidence: 1,
      model: "manual_override",
      supersedeTargetId: r.id,
    });
    if (!decided.ok) {
      console.error(`  ✗ ${r.id}: supersede failed — ${decided.error}`);
      continue;
    }
    const archived = await archiveSupersededPrompt(admin, {
      workspaceId: r.workspace_id,
      oldPromptId: r.id,
      newPromptId: proposed.id,
    });
    if (!archived.ok) {
      console.error(`  ✗ ${r.id}: archive failed — ${archived.error}`);
      continue;
    }
    console.log(`  ✓ ${r.id} → ${proposed.id} (superseded)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
