import { readFileSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const password = process.env.SUPABASE_DB_PASSWORD!;
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;

// Applied in order — later migrations depend on tables created by earlier ones.
const MIGRATIONS = [
  "20260604100000_ad_tool_phase0_product_assets.sql",
  "20260604110000_ad_tool_phase05_angles.sql",
  "20260604120000_ad_tool_phase1_core.sql",
  "20260604130000_ad_tool_phase2_avatar_proposals.sql",
  "20260604140000_ad_tool_archetype_cache.sql",
  "20260604150000_ad_avatar_candidates.sql",
  "20260604160000_ad_avatar_candidates_async.sql",
  "20260604170000_gemini_integration.sql",
  "20260604180000_ad_creative_library.sql",
];

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      const sql = readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8");
      await c.query(sql);
      console.log(`✓ applied ${file}`);
    }
    console.log("\n✓ all ad-tool migrations applied");
  } finally {
    await c.end();
  }

  // Provision the private ad-tool storage bucket (idempotent).
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && serviceKey) {
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: existing } = await admin.storage.getBucket("ad-tool");
    if (!existing) {
      // No explicit fileSizeLimit — the project's global upload cap governs.
      // Large final MP4s may need that global cap raised in Supabase settings.
      const { error } = await admin.storage.createBucket("ad-tool", { public: false });
      console.log(error ? `! bucket create: ${error.message}` : "✓ created private bucket 'ad-tool'");
    } else {
      console.log("✓ bucket 'ad-tool' already exists");
    }
  } else {
    console.log("! skipped bucket creation (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
