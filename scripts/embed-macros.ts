#!/usr/bin/env npx tsx
/**
 * Generate 1536-dim embeddings for all macros missing them.
 * Run: npx tsx scripts/embed-macros.ts
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function embed(text: string): Promise<number[] | null> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 2000),
      dimensions: 1536,
    }),
  });
  if (!res.ok) { console.error("OpenAI error:", await res.text()); return null; }
  const data = await res.json();
  return data.data?.[0]?.embedding || null;
}

async function main() {
  const { data: macros, error } = await supabase
    .from("macros")
    .select("id, name, body_text")
    .eq("workspace_id", WORKSPACE_ID)
    .is("embedding", null);

  if (error) { console.error("Query error:", error.message); process.exit(1); }
  console.log(`Found ${macros!.length} macros without embeddings\n`);

  let done = 0;
  let failed = 0;

  for (const m of macros!) {
    const text = `${m.name}. ${m.body_text}`.slice(0, 2000);
    const embedding = await embed(text);

    if (embedding) {
      await supabase
        .from("macros")
        .update({ embedding: JSON.stringify(embedding), embedding_text: text })
        .eq("id", m.id);
      done++;
    } else {
      failed++;
    }

    if (done % 50 === 0) console.log(`  ${done}/${macros!.length} embedded...`);

    // Rate limit: ~3 req/s for OpenAI embeddings
    await new Promise((r) => setTimeout(r, 350));
  }

  console.log(`\nDone! Embedded: ${done}, Failed: ${failed}, Total: ${macros!.length}`);
}

main().catch(console.error);
