#!/usr/bin/env npx tsx
/**
 * Standalone script to import macros from Gorgias into ShopCX
 * Run: npx tsx scripts/import-gorgias-macros.ts
 *
 * Requires env vars:
 *   GORGIAS_DOMAIN=superfoodscompany
 *   GORGIAS_EMAIL=dylan@superfoodscompany.com
 *   GORGIAS_API_KEY=your-api-key
 *   SUPABASE_URL=your-supabase-url
 *   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
 *   WORKSPACE_ID=your-workspace-uuid
 */

import { createClient } from "@supabase/supabase-js";

const GORGIAS_DOMAIN = process.env.GORGIAS_DOMAIN!;
const GORGIAS_EMAIL = process.env.GORGIAS_EMAIL!;
const GORGIAS_API_KEY = process.env.GORGIAS_API_KEY!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WORKSPACE_ID = process.env.WORKSPACE_ID!;

if (!GORGIAS_DOMAIN || !GORGIAS_EMAIL || !GORGIAS_API_KEY) {
  console.error("Missing GORGIAS_DOMAIN, GORGIAS_EMAIL, or GORGIAS_API_KEY");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY || !WORKSPACE_ID) {
  console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or WORKSPACE_ID");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Variable mapping: Gorgias → ShopCX
const VAR_MAP: Record<string, string> = {
  "ticket.customer.first_name": "customer.first_name",
  "ticket.customer.last_name": "customer.last_name",
  "ticket.customer.email": "customer.email",
  "ticket.customer.name": "customer.first_name",
  "ticket.id": "ticket.id",
  "ticket.subject": "ticket.subject",
  "last_message": "ticket.last_message",
};

function mapVariables(text: string): string {
  let result = text;
  for (const [gorgias, shopcx] of Object.entries(VAR_MAP)) {
    result = result.replace(
      new RegExp(`\\{\\{\\s*${gorgias.replace(".", "\\.")}\\s*\\}\\}`, "gi"),
      `{{${shopcx}}}`
    );
  }
  return result;
}

interface GorgiasMacro {
  id: number;
  name: string;
  body_text: string;
  body_html: string | null;
  tags: { name: string }[];
  actions: { type: string; value: unknown }[];
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

    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!res.ok) throw new Error(`Gorgias API error ${res.status}: ${await res.text()}`);

    const data = await res.json();
    all.push(...data.data);
    cursor = data.meta?.next_cursor || null;

    if (cursor) await new Promise((r) => setTimeout(r, 500));
  } while (cursor);

  return all;
}

async function main() {
  console.log(`Fetching macros from ${GORGIAS_DOMAIN}.gorgias.com...`);
  const macros = await fetchAllMacros();
  console.log(`Found ${macros.length} macros`);

  let imported = 0;
  let skipped = 0;

  for (const gm of macros) {
    // Check for existing
    const { data: existing } = await supabase
      .from("macros")
      .select("id")
      .eq("workspace_id", WORKSPACE_ID)
      .eq("gorgias_id", gm.id)
      .single();

    if (existing) {
      skipped++;
      continue;
    }

    const bodyText = mapVariables(gm.body_text || "");
    const bodyHtml = gm.body_html ? mapVariables(gm.body_html) : null;
    const tags = gm.tags?.map((t) => t.name) || [];

    const { error } = await supabase.from("macros").insert({
      workspace_id: WORKSPACE_ID,
      name: gm.name,
      body_text: bodyText,
      body_html: bodyHtml,
      tags,
      actions: JSON.stringify(gm.actions || []),
      gorgias_id: gm.id,
      active: true,
    });

    if (error) {
      console.error(`  Failed: ${gm.name} — ${error.message}`);
    } else {
      imported++;
      console.log(`  Imported: ${gm.name}`);
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`\nDone! Imported: ${imported}, Skipped: ${skipped}, Total: ${macros.length}`);
}

main().catch(console.error);
