#!/usr/bin/env npx tsx
/**
 * Re-import Gorgias macros with CORRECT body extraction from actions.
 * The body is in actions[].arguments.body_html/body_text where name=setResponseText.
 * Also cleans text for better embeddings.
 *
 * Run: npx tsx scripts/reimport-gorgias-macros.ts
 */

import { createClient } from "@supabase/supabase-js";

const GORGIAS_DOMAIN = process.env.GORGIAS_DOMAIN!;
const GORGIAS_EMAIL = process.env.GORGIAS_EMAIL!;
const GORGIAS_API_KEY = process.env.GORGIAS_API_KEY!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Strip HTML tags, template vars, and normalize whitespace
function cleanForEmbedding(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")                // strip HTML tags
    .replace(/\{\{[^}]+\}\}/g, "")           // strip template vars
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")                    // collapse whitespace
    .trim();
}

// Map Gorgias template vars
function mapVars(text: string): string {
  return text
    .replace(/\{\{\s*ticket\.customer\.firstname\s*\}\}/gi, "{{customer.first_name}}")
    .replace(/\{\{\s*ticket\.customer\.first_name\s*\}\}/gi, "{{customer.first_name}}")
    .replace(/\{\{\s*ticket\.customer\.lastname\s*\}\}/gi, "{{customer.last_name}}")
    .replace(/\{\{\s*ticket\.customer\.last_name\s*\}\}/gi, "{{customer.last_name}}")
    .replace(/\{\{\s*ticket\.customer\.email\s*\}\}/gi, "{{customer.email}}")
    .replace(/\{\{\s*ticket\.customer\.name\s*\}\}/gi, "{{customer.first_name}}")
    .replace(/\{\{\s*ticket\.id\s*\}\}/gi, "{{ticket.id}}")
    .replace(/\{\{\s*ticket\.subject\s*\}\}/gi, "{{ticket.subject}}");
}

async function embed(text: string): Promise<number[] | null> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000), dimensions: 1536 }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.data?.[0]?.embedding || null;
}

interface GorgiasMacro {
  id: number;
  name: string;
  actions: { name: string; arguments: { body_html?: string; body_text?: string; status?: string } }[];
}

async function fetchAllMacros(): Promise<GorgiasMacro[]> {
  const baseUrl = `https://${GORGIAS_DOMAIN}.gorgias.com/api`;
  const auth = Buffer.from(`${GORGIAS_EMAIL}:${GORGIAS_API_KEY}`).toString("base64");
  const all: GorgiasMacro[] = [];
  let cursor: string | null = null;

  do {
    const url: string = cursor
      ? `${baseUrl}/macros?limit=100&cursor=${cursor}`
      : `${baseUrl}/macros?limit=100`;

    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`Gorgias API error ${res.status}`);
    const data = await res.json();
    all.push(...data.data);
    cursor = data.meta?.next_cursor || null;
    if (cursor) await new Promise((r) => setTimeout(r, 500));
  } while (cursor);

  return all;
}

async function main() {
  console.log("Fetching macros from Gorgias...");
  const gorgiasMacros = await fetchAllMacros();
  console.log(`Found ${gorgiasMacros.length} macros\n`);

  let updated = 0;
  let embedded = 0;
  let noBody = 0;

  for (const gm of gorgiasMacros) {
    // Extract body from setResponseText action
    const responseAction = gm.actions?.find((a) => a.name === "setResponseText");
    const bodyHtml = responseAction?.arguments?.body_html || "";
    const bodyText = responseAction?.arguments?.body_text || "";

    if (!bodyHtml && !bodyText) {
      noBody++;
      continue;
    }

    // Map variables
    const mappedHtml = mapVars(bodyHtml);
    const mappedText = mapVars(bodyText || cleanForEmbedding(bodyHtml));

    // Update in DB
    const { error } = await supabase
      .from("macros")
      .update({
        body_text: mappedText,
        body_html: mappedHtml,
      })
      .eq("workspace_id", WORKSPACE_ID)
      .eq("gorgias_id", gm.id);

    if (error) {
      console.error(`  Update failed for ${gm.name}: ${error.message}`);
      continue;
    }
    updated++;

    // Generate clean embedding
    const cleanText = `${gm.name}. ${cleanForEmbedding(bodyHtml)}`.slice(0, 2000);
    const emb = await embed(cleanText);
    if (emb) {
      await supabase
        .from("macros")
        .update({ embedding: JSON.stringify(emb), embedding_text: cleanText })
        .eq("workspace_id", WORKSPACE_ID)
        .eq("gorgias_id", gm.id);
      embedded++;
    }

    if (updated % 50 === 0) console.log(`  ${updated}/${gorgiasMacros.length} updated, ${embedded} embedded...`);
    await new Promise((r) => setTimeout(r, 350));
  }

  console.log(`\nDone! Updated: ${updated}, Embedded: ${embedded}, No body: ${noBody}, Total: ${gorgiasMacros.length}`);
}

main().catch(console.error);
