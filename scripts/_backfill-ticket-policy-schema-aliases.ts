/**
 * Ship-time backfill: correct stale tickets-schema aliases in LIVE approved sonnet_prompts.
 *
 * Ground truth: Postgres rejected a `tickets.assigned_agent` select — a column that does not
 * exist — and the field name traced to an approved customer-support prompt (sonnet_prompts),
 * not to the tickets schema. The orchestrator now carries a runtime guard
 * (`canonicalizeTicketPolicySchemaTerms` in src/lib/sonnet-orchestrator-v2.ts) that rewrites the
 * known stale aliases before the text reaches the model context. This backfill is the durable
 * DATA cleanup: it corrects the stored approved-prompt text so the aliases are gone at the source,
 * not just neutralized at read time. Real tickets columns: `assigned_to` (human ownership),
 * `escalated_at` / `escalated_to` (escalation state).
 *
 * How: the sonnet_prompts WRITE surface is the SDK (src/lib/sonnet-prompts-table.ts) — a raw
 * `.from('sonnet_prompts').update(...)` would bypass the auto_decision invariants and trip
 * check:sonnet-prompts-sdk-compliance. There is no in-place content editor, so the sanctioned
 * content-change path is SUPERSEDE: propose the corrected text, mark it approved+supersede, and
 * archive the old row (reversible — the stale row is preserved, never deleted). The corrected
 * proposal inherits the old row's category / sort_order / enabled so it lands live exactly as the
 * original did.
 *
 * Idempotent: a row is only superseded when `canonicalizeTicketPolicySchemaTerms(content)` differs
 * from the stored content. After a run the live text is already canonical and the stale rows are
 * archived (status='archived'), so a re-run matches nothing. Reuses the SAME exported guard
 * function the orchestrator uses, so the backfill and the runtime guard can never drift.
 *
 * Auto-ledgered on merge by [[../src/lib/ship-time-backfill-detector]]; run on the box by
 * [[../src/lib/ship-time-backfill-executor]].
 *
 *   npx tsx scripts/_backfill-ticket-policy-schema-aliases.ts            # dry-run
 *   npx tsx scripts/_backfill-ticket-policy-schema-aliases.ts --apply    # write
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";
import { canonicalizeTicketPolicySchemaTerms } from "../src/lib/sonnet-orchestrator-v2";
import {
  proposePrompt,
  applyReviewDecision,
  archiveSupersededPrompt,
} from "../src/lib/sonnet-prompts-table";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";

interface PromptRow {
  id: string;
  workspace_id: string;
  title: string;
  content: string;
  category: string | null;
  sort_order: number | null;
  enabled: boolean | null;
}

async function main() {
  const admin = createAdminClient();

  // Only live, approved prompts can reach the model — those are the rows worth correcting.
  const { data, error } = await admin
    .from("sonnet_prompts")
    .select("id, workspace_id, title, content, category, sort_order, enabled")
    .eq("status", "approved");
  if (error) {
    console.error("[backfill-ticket-policy-schema-aliases] read failed:", error.message);
    process.exit(1);
  }

  const rows = (data as PromptRow[] | null) ?? [];
  const stale = rows.filter(
    (r) => typeof r.content === "string" && canonicalizeTicketPolicySchemaTerms(r.content) !== r.content,
  );

  console.log(
    `[backfill-ticket-policy-schema-aliases] ${rows.length} approved prompt(s); ${stale.length} carry a stale tickets-schema alias.`,
  );

  let fixed = 0;
  for (const row of stale) {
    const corrected = canonicalizeTicketPolicySchemaTerms(row.content);
    console.log(
      `\n— prompt ${row.id} (ws ${row.workspace_id}) "${row.title}"\n  BEFORE: ${row.content}\n  AFTER:  ${corrected}`,
    );
    if (!APPLY) continue;

    // Supersede path: new corrected proposal → mark approved+supersede → archive old.
    const { id: newId, error: proposeErr } = await proposePrompt(admin, {
      workspaceId: row.workspace_id,
      title: row.title,
      content: corrected,
      category: row.category ?? "rule",
      enabled: row.enabled ?? false,
      sortOrder: row.sort_order ?? 200,
    });
    if (proposeErr || !newId) {
      console.error(`  ! propose failed for ${row.id}: ${proposeErr ?? "no id returned"}`);
      continue;
    }
    const review = await applyReviewDecision(admin, {
      workspaceId: row.workspace_id,
      promptId: newId,
      finalDecision: "supersede",
      supersedeTargetId: row.id,
      reasoning:
        "ticket-policy-schema-alias-guard backfill: rewrote stale tickets column name(s) " +
        "(assigned_agent → assigned_to, tickets.escalated → tickets.escalated_at) to the real schema.",
      confidence: 1,
      model: "manual_override",
    });
    if (!review.ok) {
      console.error(`  ! supersede stamp failed for new ${newId}: ${review.error}`);
      continue;
    }
    const archive = await archiveSupersededPrompt(admin, {
      workspaceId: row.workspace_id,
      oldPromptId: row.id,
      newPromptId: newId,
    });
    if (!archive.ok) {
      console.error(`  ! archive failed for old ${row.id}: ${archive.error}`);
      continue;
    }
    fixed++;
    console.log(`  ✓ superseded by ${newId}; old row archived.`);
  }

  console.log(
    `\n[backfill-ticket-policy-schema-aliases] ${APPLY ? `applied ${fixed}/${stale.length} correction(s).` : `dry-run — ${stale.length} would be corrected (pass --apply to write).`}`,
  );
}

main().catch((e) => {
  console.error("[backfill-ticket-policy-schema-aliases] fatal:", errText(e));
  process.exit(1);
});
