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

  // Search macros by embedding similarity
  const macros: RetrievedMacro[] = [];
  const { data: allMacros } = await admin
    .from("macros")
    .select("id, name, body_text, body_html, category, embedding")
    .eq("workspace_id", workspaceId)
    .eq("active", true)
    .not("embedding", "is", null);

  if (allMacros?.length) {
    // Compute cosine similarity manually since macros table doesn't have an RPC
    const scored = allMacros
      .map((m) => {
        const macroEmb = typeof m.embedding === "string" ? JSON.parse(m.embedding) : m.embedding;
        const sim = cosineSimilarity(embedding, macroEmb);
        return { ...m, similarity: sim };
      })
      .filter((m) => m.similarity > 0.60)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);

    for (const m of scored) {
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

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
