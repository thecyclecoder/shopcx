/**
 * Support-content SDK — the write chokepoint for `public.knowledge_base` (help-center articles)
 * and `public.macros` (canned support replies).
 *
 * WHY: both tables feed customer-facing AI. Knowledge-base articles are chunked into `kb_chunks`
 * and retrieved by RAG ([[rag]]); macros carry their own `embedding` and are suggested to the
 * support orchestrator. A content edit that forgets to re-embed leaves the AI quoting the OLD
 * text from the stale vector index — the edit looks done in the dashboard but the AI keeps
 * repeating the wrong fact. That is exactly how "Mixed Berry Tabs have 40mg of caffeine" (the
 * label says 100mg) survived in 8 places in Nov 2026. Every content write therefore goes through
 * here so the re-embed rides along with it.
 *
 * Writes are workspace-scoped (`workspace_id` on every predicate) and typed.
 *
 * Enforced by `scripts/_check-support-content-sdk-compliance.ts` as a RATCHET: files that already
 * wrote these tables before this SDK existed are grandfathered in that script's allowlist; any NEW
 * raw `.from('knowledge_base'|'macros').update/insert/upsert/delete` fails `predeploy`. Migrate a
 * grandfathered caller here and remove it from the allowlist when you touch it.
 *
 * Brain: docs/brain/libraries/support-content.md
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { chunkDocument } from "@/lib/kb-chunker";
import { generateEmbedding1536 } from "@/lib/embeddings";
import { inngest } from "@/lib/inngest/client";

type Admin = SupabaseClient;

export interface KbArticleRow {
  id: string;
  workspace_id: string;
  title: string;
  content: string;
  content_html: string | null;
  published: boolean | null;
  active: boolean;
  updated_at: string;
}

export interface MacroRow {
  id: string;
  workspace_id: string;
  name: string;
  body_text: string;
  body_html: string | null;
  active: boolean;
  updated_at: string;
}

const KB_COLS = "id, workspace_id, title, content, content_html, published, active, updated_at";
const MACRO_COLS = "id, workspace_id, name, body_text, body_html, active, updated_at";

/** How an article's RAG chunks are rebuilt after a content edit. */
export type KbReembedMode =
  /** Fire `kb/document.updated` → [[../inngest/kb-embed]] rebuilds chunks async (app routes). */
  | "event"
  /** Rebuild chunks in-process before returning (scripts/backfills with no Inngest key). */
  | "inline";

/* ---------------------------------------------------------------------------------------------
 * Reads
 * ------------------------------------------------------------------------------------------- */

export async function getKbArticle(
  admin: Admin,
  workspaceId: string,
  id: string,
): Promise<KbArticleRow | null> {
  const { data, error } = await admin
    .from("knowledge_base")
    .select(KB_COLS)
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getKbArticle(${id}): ${error.message}`);
  return (data as KbArticleRow | null) ?? null;
}

export async function getMacro(admin: Admin, workspaceId: string, id: string): Promise<MacroRow | null> {
  const { data, error } = await admin
    .from("macros")
    .select(MACRO_COLS)
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getMacro(${id}): ${error.message}`);
  return (data as MacroRow | null) ?? null;
}

/* ---------------------------------------------------------------------------------------------
 * Re-embedding
 * ------------------------------------------------------------------------------------------- */

/**
 * Rebuild one article's `kb_chunks` in-process: chunk `content`, delete the old chunks, embed +
 * insert the new ones. Same steps as the [[../inngest/kb-embed]] function, for callers that
 * cannot rely on Inngest (one-off scripts). Returns the number of chunks written.
 */
export async function reembedKbArticle(admin: Admin, workspaceId: string, id: string): Promise<number> {
  const article = await getKbArticle(admin, workspaceId, id);
  if (!article) throw new Error(`reembedKbArticle: article ${id} not found in workspace ${workspaceId}`);
  const chunks = chunkDocument(article.content);
  const { error: delErr } = await admin.from("kb_chunks").delete().eq("kb_id", id).eq("workspace_id", workspaceId);
  if (delErr) throw new Error(`reembedKbArticle(${id}) delete chunks: ${delErr.message}`);
  let written = 0;
  for (const chunk of chunks) {
    const embedding = await generateEmbedding1536(chunk.chunk_text);
    const { error } = await admin.from("kb_chunks").insert({
      kb_id: id,
      workspace_id: workspaceId,
      chunk_text: chunk.chunk_text,
      embedding: embedding ? JSON.stringify(embedding) : null,
      chunk_index: chunk.chunk_index,
    });
    if (error) throw new Error(`reembedKbArticle(${id}) insert chunk ${chunk.chunk_index}: ${error.message}`);
    written++;
  }
  return written;
}

/** Recompute a macro's `embedding` from `name. body_text` (the shape the macro suggester matches). */
export async function reembedMacro(admin: Admin, workspaceId: string, id: string): Promise<boolean> {
  const macro = await getMacro(admin, workspaceId, id);
  if (!macro) throw new Error(`reembedMacro: macro ${id} not found in workspace ${workspaceId}`);
  const text = `${macro.name}. ${macro.body_text}`.slice(0, 2000);
  const embedding = await generateEmbedding1536(text);
  if (!embedding) return false;
  const { error } = await admin
    .from("macros")
    .update({ embedding: JSON.stringify(embedding), embedding_text: text })
    .eq("workspace_id", workspaceId)
    .eq("id", id);
  if (error) throw new Error(`reembedMacro(${id}): ${error.message}`);
  return true;
}

/* ---------------------------------------------------------------------------------------------
 * Content writes (always re-embed)
 * ------------------------------------------------------------------------------------------- */

export interface UpdateKbArticleContentArgs {
  workspaceId: string;
  id: string;
  content: string;
  /** Rendered help-center HTML. Omit to leave `content_html` untouched. */
  contentHtml?: string;
  /** Default `"event"`. Scripts pass `"inline"`. */
  reembed?: KbReembedMode;
}

/** Update an article's text (+ optional HTML) and rebuild its RAG chunks. Returns the new row. */
export async function updateKbArticleContent(
  args: UpdateKbArticleContentArgs,
  admin: Admin = createAdminClient(),
): Promise<KbArticleRow> {
  const updates: Record<string, unknown> = { content: args.content, updated_at: new Date().toISOString() };
  if (args.contentHtml !== undefined) updates.content_html = args.contentHtml;
  const { data, error } = await admin
    .from("knowledge_base")
    .update(updates)
    .eq("workspace_id", args.workspaceId)
    .eq("id", args.id)
    .select(KB_COLS)
    .maybeSingle();
  if (error) throw new Error(`updateKbArticleContent(${args.id}): ${error.message}`);
  if (!data) throw new Error(`updateKbArticleContent: article ${args.id} not found in workspace ${args.workspaceId}`);

  if ((args.reembed ?? "event") === "inline") {
    await reembedKbArticle(admin, args.workspaceId, args.id);
  } else {
    await inngest.send({ name: "kb/document.updated", data: { kb_id: args.id, workspace_id: args.workspaceId } });
  }
  return data as KbArticleRow;
}

export interface UpdateMacroBodyArgs {
  workspaceId: string;
  id: string;
  bodyText: string;
  /** Rendered HTML used by the ticket composer. Omit to leave `body_html` untouched. */
  bodyHtml?: string;
}

/** Update a macro's body (+ optional HTML) and recompute its embedding. Returns the new row. */
export async function updateMacroBody(args: UpdateMacroBodyArgs, admin: Admin = createAdminClient()): Promise<MacroRow> {
  const updates: Record<string, unknown> = { body_text: args.bodyText, updated_at: new Date().toISOString() };
  if (args.bodyHtml !== undefined) updates.body_html = args.bodyHtml;
  const { data, error } = await admin
    .from("macros")
    .update(updates)
    .eq("workspace_id", args.workspaceId)
    .eq("id", args.id)
    .select(MACRO_COLS)
    .maybeSingle();
  if (error) throw new Error(`updateMacroBody(${args.id}): ${error.message}`);
  if (!data) throw new Error(`updateMacroBody: macro ${args.id} not found in workspace ${args.workspaceId}`);
  await reembedMacro(admin, args.workspaceId, args.id);
  return data as MacroRow;
}
