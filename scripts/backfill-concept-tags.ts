/**
 * winners-flow Phase 2c — backfill `concept_tags` on the EXISTING library ads.
 *
 * Every ad collected before the winners-flow lacks the unified strategic breakdown
 * ({ angle, archetype, why_it_works, cialdini_lever, awareness_stage, format }) that
 * Dahlia researches on + Max grades. New ingests carry it (LANE A from AdLibrary, LANE B
 * from our vision); this re-visions the legacy statics ONCE so the whole library is uniform.
 *
 * Reads OUR stored downscaled copy (creative-shots bucket, `thumb_path`) — never re-fetches
 * the full-res AdLibrary source. Idempotent + resumable: only touches rows where
 * `concept_tags IS NULL`. Also fills any still-null structural slots from the fresh vision.
 *
 *   npx tsx scripts/backfill-concept-tags.ts [--limit=N] [--dry] [--ws=<workspaceId>]
 */
import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { visionDeconstruct, signCreativeShot } from "@/lib/creative-skeleton";

const DEFAULT_WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods
const THROTTLE_MS = 1200;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : undefined;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ws = arg("ws") || DEFAULT_WS;
  const limit = arg("limit") ? Math.max(1, parseInt(arg("limit")!, 10)) : Infinity;
  const dry = process.argv.includes("--dry");
  const admin = createAdminClient();

  const { data: rows, error } = await admin
    .from("creative_skeletons")
    .select("id, dedup_key, advertiser, thumb_path, hook, mechanism_claim, proof, offer, format, framework")
    .eq("workspace_id", ws)
    .eq("source", "adlibrary")
    .eq("media_type", "static")
    .is("concept_tags", null)
    .not("thumb_path", "is", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  const todo = (rows || []).slice(0, limit === Infinity ? undefined : limit);
  console.log(`[backfill-concept-tags] ${rows?.length ?? 0} rows need concept_tags; processing ${todo.length}${dry ? " (DRY RUN)" : ""}`);

  let done = 0, failed = 0, skipped = 0;
  for (const row of todo) {
    try {
      const signed = await signCreativeShot(row.thumb_path as string);
      if (!signed) { skipped++; console.warn(`  ⚠️  ${row.dedup_key}: no signed url`); continue; }
      const res = await fetch(signed);
      if (!res.ok) { skipped++; console.warn(`  ⚠️  ${row.dedup_key}: thumb fetch ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const skeleton = await visionDeconstruct(ws, buf, "image/jpeg");
      if (!skeleton?.concept_tags) { failed++; console.warn(`  ✗ ${row.dedup_key}: vision returned no concept_tags`); await sleep(THROTTLE_MS); continue; }

      if (!dry) {
        // Fill concept_tags; also backfill any still-null STRUCTURAL slot from the fresh vision
        // (never overwrite an existing value — the original ingest's read stands).
        const patch: Record<string, unknown> = {
          concept_tags: skeleton.concept_tags,
          updated_at: new Date().toISOString(),
        };
        for (const k of ["hook", "mechanism_claim", "proof", "offer", "format", "framework"] as const) {
          if (row[k] == null && skeleton[k] != null) patch[k] = skeleton[k];
        }
        const { error: upErr } = await admin.from("creative_skeletons").update(patch).eq("id", row.id);
        if (upErr) { failed++; console.warn(`  ✗ ${row.dedup_key}: update ${upErr.message}`); await sleep(THROTTLE_MS); continue; }
      }
      done++;
      if (done % 10 === 0 || done === todo.length) console.log(`  … ${done}/${todo.length} (${row.advertiser}: ${skeleton.concept_tags.angle})`);
      await sleep(THROTTLE_MS);
    } catch (e) {
      failed++;
      console.warn(`  ✗ ${row.dedup_key}: ${(e as Error).message}`);
      await sleep(THROTTLE_MS);
    }
  }
  console.log(`[backfill-concept-tags] done=${done} failed=${failed} skipped=${skipped}${dry ? " (DRY — nothing written)" : ""}`);
})().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
