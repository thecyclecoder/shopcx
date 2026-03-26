// Inngest function: embed KB document chunks
// Triggered when a KB article is created or updated

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { chunkDocument } from "@/lib/kb-chunker";
import { generateEmbedding1536 } from "@/lib/embeddings";

export const kbEmbedDocument = inngest.createFunction(
  {
    id: "kb-embed-document",
    retries: 2,
    triggers: [{ event: "kb/document.updated" }],
  },
  async ({ event, step }) => {
    const { kb_id, workspace_id } = event.data as {
      kb_id: string;
      workspace_id: string;
    };

    // Step 1: Fetch article content
    const article = await step.run("fetch-article", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("knowledge_base")
        .select("id, title, content, category")
        .eq("id", kb_id)
        .single();
      return data;
    });

    if (!article) return { error: "Article not found" };

    // Step 2: Chunk the document
    const chunks = await step.run("chunk-document", async () => {
      return chunkDocument(article.content);
    });

    // Step 3: Delete existing chunks
    await step.run("delete-old-chunks", async () => {
      const admin = createAdminClient();
      await admin.from("kb_chunks").delete().eq("kb_id", kb_id);
    });

    // Step 4: Generate embeddings and insert chunks
    let embedded = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      await step.run(`embed-chunk-${i}`, async () => {
        const admin = createAdminClient();
        const embedding = await generateEmbedding1536(chunk.chunk_text);

        await admin.from("kb_chunks").insert({
          kb_id,
          workspace_id,
          chunk_text: chunk.chunk_text,
          embedding: embedding ? JSON.stringify(embedding) : null,
          chunk_index: chunk.chunk_index,
        });

        return !!embedding;
      });
      embedded++;
    }

    return { chunks: chunks.length, embedded };
  }
);
