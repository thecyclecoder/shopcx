/**
 * One-shot migration: move existing tickets with channel='social_comments'
 * into the new social_comments + social_comment_replies tables.
 *
 * Run:
 *   npx tsx scripts/migrate-social-comments-tickets.ts --dry-run
 *   npx tsx scripts/migrate-social-comments-tickets.ts --confirm
 *
 * What it does:
 *   1. Find every ticket with channel='social_comments' in the workspace
 *      that already has a meta_pages row for the same page.
 *   2. For each ticket:
 *        a. Resolve meta_pages row from the ticket's meta_post_id /
 *           workspace_id (best effort — falls back to the workspace's
 *           default page if only one is connected).
 *        b. Insert one social_comments row, mapping:
 *             tickets.meta_comment_id → meta_comment_id
 *             tickets.meta_post_id    → meta_post_id
 *             tickets.meta_sender_id  → meta_sender_id
 *             first inbound message   → body
 *        c. For each ticket_messages row, insert a social_comment_replies
 *           row (inbound = customer, outbound = agent/ai).
 *        d. Archive the original ticket: status='archived', set tag
 *           'migrated_to_social_comments'.
 *
 *  Idempotent: rows that already exist (by workspace_id + meta_comment_id)
 *  are skipped. Re-running the script picks up any tickets created since
 *  the last run.
 *
 *  HOLD BEFORE RUNNING — coordinate with the operator. The followup
 *  retire-constraint migration (Phase 12) only runs after this completes
 *  with zero outstanding social_comments-channel tickets.
 */

import { readFileSync } from "fs";
import { errText } from "../src/lib/error-text";

const envPath = "/Users/admin/Projects/shopcx/.env.local";
try {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
} catch {
  console.warn("No .env.local found — relying on shell env");
}

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--confirm");

interface TicketRow {
  id: string;
  workspace_id: string;
  meta_sender_id: string | null;
  meta_comment_id: string | null;
  meta_post_id: string | null;
  status: string;
  tags: string[] | null;
  created_at: string;
  subject: string | null;
}

interface TicketMessage {
  id: string;
  direction: string;
  author_type: string;
  author_user_id: string | null;
  body: string | null;
  body_clean: string | null;
  meta_message_id: string | null;
  visibility: string;
  created_at: string;
}

interface MetaPageRow {
  id: string;
  meta_page_id: string;
}

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE — will write to database"}`);
  console.log("");

  const { data: tickets, error: ticketsErr } = await admin
    .from("tickets")
    .select(
      "id, workspace_id, meta_sender_id, meta_comment_id, meta_post_id, status, tags, created_at, subject",
    )
    .eq("channel", "social_comments")
    .neq("status", "archived")
    .order("created_at", { ascending: true });

  if (ticketsErr) {
    console.error("Failed to load tickets:", ticketsErr.message);
    process.exit(1);
  }

  console.log(`Found ${tickets?.length ?? 0} candidate tickets`);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const t of (tickets as TicketRow[]) || []) {
    try {
      if (!t.meta_comment_id) {
        console.log(`  - skip ${t.id}: no meta_comment_id`);
        skipped += 1;
        continue;
      }

      // Already-migrated? Check social_comments by (workspace, comment id).
      const { data: existing } = await admin
        .from("social_comments")
        .select("id")
        .eq("workspace_id", t.workspace_id)
        .eq("meta_comment_id", t.meta_comment_id)
        .maybeSingle();
      if (existing) {
        console.log(`  - skip ${t.id}: social_comments row already exists`);
        skipped += 1;
        continue;
      }

      // Resolve meta_pages. The original ticket has no meta_page_id
      // FK so we fall back to the workspace's first active page —
      // accurate when only one page is connected (default case).
      const { data: pages } = await admin
        .from("meta_pages")
        .select("id, meta_page_id")
        .eq("workspace_id", t.workspace_id)
        .eq("is_active", true);
      if (!pages || pages.length === 0) {
        console.log(`  - skip ${t.id}: no meta_pages row for workspace`);
        skipped += 1;
        continue;
      }
      const page: MetaPageRow = pages[0];

      const { data: messages } = await admin
        .from("ticket_messages")
        .select(
          "id, direction, author_type, author_user_id, body, body_clean, meta_message_id, visibility, created_at",
        )
        .eq("ticket_id", t.id)
        .order("created_at", { ascending: true });

      const firstInbound = (messages as TicketMessage[] | null)?.find(
        m => m.direction === "inbound" && m.visibility === "external",
      );
      const body = firstInbound?.body_clean || firstInbound?.body || t.subject || "";

      if (DRY_RUN) {
        console.log(
          `  + would migrate ${t.id} → social_comments (${(messages?.length ?? 0)} messages, body: ${body.slice(0, 50)}…)`,
        );
      } else {
        const { data: newComment, error: insertErr } = await admin
          .from("social_comments")
          .insert({
            workspace_id: t.workspace_id,
            meta_page_id: page.id,
            meta_comment_id: t.meta_comment_id,
            meta_post_id: t.meta_post_id || "",
            meta_sender_id: t.meta_sender_id || "unknown",
            body: stripHtml(body),
            is_ad: false,
            page_type: "brand",
            status: t.status === "closed" ? "replied" : "open",
            moderation_source: "agent_manual",
            created_at: t.created_at,
          })
          .select("id")
          .single();

        if (insertErr || !newComment) {
          console.log(`  ! failed ${t.id}: ${insertErr?.message}`);
          failed += 1;
          continue;
        }

        // Replies — every ticket_message becomes a social_comment_replies row.
        for (const m of (messages as TicketMessage[] | null) || []) {
          if (m.visibility !== "external") continue; // skip internal notes
          if (m.id === firstInbound?.id) continue; // already captured as the comment body
          await admin.from("social_comment_replies").insert({
            workspace_id: t.workspace_id,
            social_comment_id: newComment.id,
            meta_reply_id: m.meta_message_id || `migrated:${m.id}`,
            meta_sender_id: m.direction === "inbound" ? t.meta_sender_id : null,
            direction: m.direction === "inbound" ? "inbound" : "outbound",
            author_type: m.author_type as "customer" | "agent" | "ai" | "system",
            author_user_id: m.author_user_id,
            body: stripHtml(m.body_clean || m.body || ""),
            send_status: m.direction === "outbound" ? "sent" : null,
            created_at: m.created_at,
          });
        }

        // Archive original ticket. We keep the row so audit trail
        // survives — just flag it so the queue stops showing it.
        const newTags = Array.from(new Set([...(t.tags || []), "migrated_to_social_comments"]));
        await admin
          .from("tickets")
          .update({ status: "archived", tags: newTags })
          .eq("id", t.id);

        console.log(`  + migrated ${t.id} → ${newComment.id}`);
      }
      migrated += 1;
    } catch (err) {
      console.log(`  ! exception ${t.id}: ${errText(err)}`);
      failed += 1;
    }
  }

  console.log("");
  console.log(`Summary: ${migrated} ${DRY_RUN ? "would migrate" : "migrated"}, ${skipped} skipped, ${failed} failed`);
  if (DRY_RUN) {
    console.log("Re-run with --confirm to actually write changes.");
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

void main();
