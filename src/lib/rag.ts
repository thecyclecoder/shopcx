// RAG (Retrieval-Augmented Generation) for AI agent
// Retrieves relevant KB chunks and macros for a given query

import { createAdminClient } from "@/lib/supabase/admin";
import { generateEmbedding1536 } from "@/lib/embeddings";

export interface RetrievedChunk {
  id: string;
  kb_id: string;
  chunk_text: string;
  chunk_index: number;
  similarity: number;
  kb_title: string;
  kb_category: string;
}

export interface RetrievedMacro {
  id: string;
  name: string;
  body_text: string;
  body_html: string | null;
  category: string | null;
  similarity: number;
}

export interface RAGContext {
  chunks: RetrievedChunk[];
  macros: RetrievedMacro[];
  chunkIds: string[];
  macroIds: string[];
}

export async function retrieveContext(
  workspaceId: string,
  query: string,
  topK: number = 10,
): Promise<RAGContext> {
  const admin = createAdminClient();

  const embedding = await generateEmbedding1536(query);
  if (!embedding) {
    return { chunks: [], macros: [], chunkIds: [], macroIds: [] };
  }

  // Search KB chunks
  const { data: rawChunks } = await admin.rpc("match_kb_chunks", {
    query_embedding: JSON.stringify(embedding),
    ws_id: workspaceId,
    match_threshold: 0.65,
    match_count: topK,
  });

  // Enrich chunks with KB article info
  const chunks: RetrievedChunk[] = [];
  if (rawChunks?.length) {
    const kbIds = [...new Set(rawChunks.map((c: { kb_id: string }) => c.kb_id))];
    const { data: kbArticles } = await admin
      .from("knowledge_base")
      .select("id, title, category")
      .in("id", kbIds);

    const kbMap = new Map((kbArticles || []).map((a) => [a.id, a]));

    for (const c of rawChunks) {
      const kb = kbMap.get(c.kb_id);
      chunks.push({
        ...c,
        kb_title: kb?.title || "Unknown",
        kb_category: kb?.category || "general",
      });
    }
  }

  // Search macros by embedding similarity via RPC
  const macros: RetrievedMacro[] = [];
  const { data: matchedMacros } = await admin.rpc("match_macros", {
    query_embedding: JSON.stringify(embedding),
    ws_id: workspaceId,
    match_threshold: 0.45,
    match_count: 5,
  });

  if (matchedMacros?.length) {
    for (const m of matchedMacros) {
      macros.push({
        id: m.id,
        name: m.name,
        body_text: m.body_text,
        body_html: m.body_html,
        category: m.category,
        similarity: m.similarity,
      });
    }
  }

  return {
    chunks,
    macros,
    chunkIds: chunks.map((c) => c.id),
    macroIds: macros.map((m) => m.id),
  };
}

