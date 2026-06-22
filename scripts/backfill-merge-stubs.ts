/**
 * Backfill merged-source tickets to the new "Option B" shape.
 *
 * Background: until 2026-06-05 the merge code COPIED messages to the
 * target ticket and KEPT them on the source ticket. Source rows lived on
 * in the dashboard with full conversation history that duplicated whatever
 * was now on the target. This script reconciles existing merged sources:
 *
 *   1. Walk merged_into chain to the terminal target (handles A→B→C cases).
 *   2. Reconcile source's ticket_messages with target:
 *      - "merged into" system breadcrumbs are dropped (redundant noise).
 *      - Exact twins (same body + author + created_at + direction) are
 *        deleted from source (target has the copy).
 *      - Orphans (no twin on target — typically post-merge activity that
 *        landed on the source after the old merge code ran) are moved
 *        to target so the conversation history stays whole.
 *   3. Repoint FK references (returns, agent_todos, ticket_analyses, etc.)
 *      from source to terminal target.
 *   4. Carry the source's escalation flags forward to the target if the
 *      target doesn't already have escalation, then clear on source.
 *   5. Ensure source is archived (some of these were unarchived earlier
 *      in the migration when the rule was "escalated never archived" —
 *      now the escalation moves to the target, so source can be archived).
 *
 * Usage:
 *   npx tsx scripts/backfill-merge-stubs.ts                # dry run
 *   npx tsx scripts/backfill-merge-stubs.ts --apply        # write
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}

const APPLY = process.argv.includes("--apply");
const WORKSPACE_ID = process.env.AGENT_TODO_WORKSPACE_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { repointTicketRefs, resolveMergedTarget } = await import("../src/lib/ticket-merge");
  const admin = createAdminClient();

  console.log(`[backfill] workspace ${WORKSPACE_ID} · mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);

  const { data: sources } = await admin.from("tickets")
    .select("id, status, escalated_at, escalated_to, escalation_reason, merged_into, archived_at, subject")
    .eq("workspace_id", WORKSPACE_ID)
    .not("merged_into", "is", null)
    .order("created_at", { ascending: true });

  if (!sources?.length) {
    console.log("No merged source tickets found.");
    return;
  }

  console.log(`Found ${sources.length} merged-source tickets.`);

  let totals = {
    messagesDeleted: 0,
    messagesMoved: 0,
    breadcrumbsDropped: 0,
    fksRepointed: 0,
    escalationsCarried: 0,
    reArchived: 0,
    chainsCollapsed: 0,
    skipped: 0,
  };

  for (const src of sources) {
    const stub = `${src.id.slice(0, 8)} → ${(src.merged_into || "").slice(0, 8)}`;

    // 1. Walk chain to terminal target (handles A→B→C)
    const terminal = await resolveMergedTarget(admin, src.merged_into!);
    if (terminal !== src.merged_into) {
      console.log(`  ${stub}: chain — terminal ${terminal.slice(0, 8)}`);
      totals.chainsCollapsed++;
      if (APPLY) {
        await admin.from("tickets").update({ merged_into: terminal }).eq("id", src.id);
      }
    }
    if (terminal === src.id) {
      console.log(`  ${stub}: self-merge cycle — skipping`);
      totals.skipped++;
      continue;
    }

    // 2. Reconcile messages: dedupe twins, move orphans, drop breadcrumbs.
    const { data: srcMsgs } = await admin.from("ticket_messages")
      .select("id, body, author_type, created_at, direction")
      .eq("ticket_id", src.id);
    const { data: tgtMsgs } = await admin.from("ticket_messages")
      .select("body, author_type, created_at, direction")
      .eq("ticket_id", terminal);

    const toDelete: string[] = [];
    const toMove: string[] = [];
    let breadcrumbsDropped = 0;
    for (const sm of srcMsgs || []) {
      // Drop the per-source merge breadcrumb — the target has its own
      // "merged ticket X into this" note which is more useful.
      if (sm.author_type === "system" && /\[System\] This ticket was merged into ticket /i.test(sm.body || "")) {
        toDelete.push(sm.id);
        breadcrumbsDropped++;
        continue;
      }
      const twin = (tgtMsgs || []).find(tm =>
        tm.body === sm.body &&
        tm.author_type === sm.author_type &&
        tm.created_at === sm.created_at &&
        tm.direction === sm.direction,
      );
      if (twin) {
        toDelete.push(sm.id);
      } else {
        toMove.push(sm.id);
      }
    }
    if (APPLY) {
      if (toDelete.length) {
        await admin.from("ticket_messages").delete().in("id", toDelete);
      }
      if (toMove.length) {
        await admin.from("ticket_messages").update({ ticket_id: terminal }).in("id", toMove);
      }
    }
    totals.messagesDeleted += toDelete.length - breadcrumbsDropped;
    totals.breadcrumbsDropped += breadcrumbsDropped;
    totals.messagesMoved += toMove.length;

    // 3. Repoint FKs from source → terminal target
    if (APPLY) {
      const reps = await repointTicketRefs(admin, src.id, terminal);
      for (const r of reps) {
        if (r.error) console.log(`    ! ${r.table}: ${r.error}`);
        else if (r.updated > 0) totals.fksRepointed += r.updated;
      }
    }

    // 4. Carry escalation to target (if target doesn't have one)
    if (src.escalated_at || src.escalated_to) {
      const { data: tgt } = await admin.from("tickets")
        .select("escalated_at, escalated_to")
        .eq("id", terminal)
        .single();
      if (!tgt?.escalated_at && !tgt?.escalated_to) {
        if (APPLY) {
          await admin.from("tickets").update({
            escalated_at: src.escalated_at,
            escalated_to: src.escalated_to,
            escalation_reason: src.escalation_reason,
            updated_at: new Date().toISOString(),
          }).eq("id", terminal);
        }
        totals.escalationsCarried++;
      }
      // Always clear escalation on source — even if target already had its own.
      if (APPLY) {
        await admin.from("tickets").update({
          escalated_at: null,
          escalated_to: null,
          escalation_reason: null,
        }).eq("id", src.id);
      }
    }

    // 5. Re-archive source if it's not already archived
    if (src.status !== "archived") {
      if (APPLY) {
        await admin.from("tickets").update({
          status: "archived",
          archived_at: src.archived_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", src.id);
      }
      totals.reArchived++;
    }

    if ((srcMsgs?.length || 0) > 0) {
      console.log(`  ${stub}: ${srcMsgs?.length} msgs · ${toDelete.length - breadcrumbsDropped} dup + ${breadcrumbsDropped} crumb + ${toMove.length} move`);
    }
  }

  console.log("\n=== TOTALS ===");
  console.log(`  duplicate messages deleted: ${totals.messagesDeleted}`);
  console.log(`  orphan messages moved:      ${totals.messagesMoved}`);
  console.log(`  merge breadcrumbs dropped:  ${totals.breadcrumbsDropped}`);
  console.log(`  FK rows repointed:       ${totals.fksRepointed}`);
  console.log(`  escalations carried:     ${totals.escalationsCarried}`);
  console.log(`  re-archived:             ${totals.reArchived}`);
  console.log(`  chains collapsed:        ${totals.chainsCollapsed}`);
  console.log(`  skipped:                 ${totals.skipped}`);
  console.log(`\n${APPLY ? "✓ Applied." : "(dry run — pass --apply to write)"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
