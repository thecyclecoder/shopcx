/**
 * Ship-time backfill — give every legacy `creative_skeletons` row OUR OWN hosted copy of its
 * creative, before the AdLibrary subscription goes away.
 *
 * WHY THIS IS URGENT AND ORDER-DEPENDENT (founder 2026-08-24, full replacement):
 * Rows created before migration `20260807120000` have `thumb_path = NULL` and no local copy. The
 * dashboard renders them through `/api/ads/creative-finder/media`, which live-proxies AdLibrary
 * with the Bearer key and is host-allowlisted to `adlibrary.com`. The moment that subscription
 * lapses, those images are gone permanently — AdLibrary is the only place the bytes exist.
 *
 * So: run this WHILE `ADLIBRARY_API_KEY` is still valid. It is deliberately SELF-CONTAINED (it does
 * not import `src/lib/adlibrary`, which the migration deletes) so it keeps working from any commit.
 *
 * Idempotent + resumable: only touches rows where `thumb_path IS NULL`, and a row that succeeds is
 * stamped immediately, so a re-run skips it. Safe to run repeatedly.
 *
 * Usage:
 *   npx tsx scripts/_backfill-legacy-creative-thumbs.ts            # dry run — reports, writes nothing
 *   npx tsx scripts/_backfill-legacy-creative-thumbs.ts --apply    # actually backfill
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";
import sharp from "sharp";

const APPLY = process.argv.includes("--apply");
const BUCKET = "creative-shots";
const ADLIBRARY_API_KEY = process.env.ADLIBRARY_API_KEY;
/** Mirrors `toDisplayImage` in src/lib/creative-skeleton.ts — same 2048px q88 display copy. */
const MAX_EDGE = 2048;
const QUALITY = 88;
const CHUNK = 25;

interface Row {
  id: string;
  workspace_id: string;
  dedup_key: string;
  advertiser: string | null;
  image_url: string | null;
}

async function fetchCreativeBytes(url: string): Promise<Buffer> {
  // AdLibrary creative urls 403 without the Bearer key — on the preview AND the resource urls.
  const res = await fetch(url, {
    headers: ADLIBRARY_API_KEY ? { Authorization: `Bearer ${ADLIBRARY_API_KEY}` } : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("empty body");
  return buf;
}

async function main() {
  if (!ADLIBRARY_API_KEY) {
    console.error(
      "✗ ADLIBRARY_API_KEY is not set. This backfill can ONLY run while the AdLibrary\n" +
        "  subscription is live — that key is the sole source for these bytes.",
    );
    process.exit(1);
  }

  const admin = createAdminClient();

  // Page through every legacy row (Supabase caps an unbounded select at 1000).
  const legacy: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("creative_skeletons")
      .select("id, workspace_id, dedup_key, advertiser, image_url")
      .is("thumb_path", null)
      .not("image_url", "is", null)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    const batch = (data ?? []) as Row[];
    legacy.push(...batch);
    if (batch.length < 1000) break;
  }

  console.log(`legacy rows needing a local copy: ${legacy.length}`);
  if (!legacy.length) return console.log("nothing to do — every row already has thumb_path");

  const byAdvertiser = new Map<string, number>();
  for (const r of legacy) byAdvertiser.set(r.advertiser ?? "?", (byAdvertiser.get(r.advertiser ?? "?") ?? 0) + 1);
  console.log(
    `  advertisers: ${[...byAdvertiser.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([a, n]) => `${a}=${n}`)
      .join(" · ")}`,
  );

  if (!APPLY) {
    console.log("\nDRY RUN — re-run with --apply to backfill.");
    return;
  }

  // Bucket must exist before the first upload (it does in prod; this makes the script standalone).
  const { data: bucket } = await admin.storage.getBucket(BUCKET);
  if (!bucket) await admin.storage.createBucket(BUCKET, { public: false });

  let ok = 0;
  let failed = 0;
  const failures: Array<{ id: string; advertiser: string | null; reason: string }> = [];

  for (let i = 0; i < legacy.length; i += CHUNK) {
    const chunk = legacy.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (row) => {
        try {
          const raw = await fetchCreativeBytes(row.image_url!);
          const display = await sharp(raw)
            .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: QUALITY })
            .toBuffer();

          const path = `${row.workspace_id}/${row.dedup_key}.jpg`;
          const { error: upErr } = await admin.storage
            .from(BUCKET)
            .upload(path, display, { contentType: "image/jpeg", upsert: true });
          if (upErr) throw upErr;

          // Stamp immediately so a re-run skips this row even if a later one crashes.
          const { error: updErr } = await admin
            .from("creative_skeletons")
            .update({ thumb_path: path })
            .eq("id", row.id);
          if (updErr) throw updErr;
          ok++;
        } catch (e) {
          failed++;
          failures.push({
            id: row.id,
            advertiser: row.advertiser,
            reason: errText(e),
          });
        }
      }),
    );
    console.log(`  ${Math.min(i + CHUNK, legacy.length)}/${legacy.length} · ok=${ok} failed=${failed}`);
  }

  console.log(`\nbackfilled ${ok}/${legacy.length}${failed ? ` · ${failed} failed` : ""}`);
  if (failures.length) {
    console.log("\nfailures (these rows will lose their image when AdLibrary lapses):");
    for (const f of failures.slice(0, 30)) {
      console.log(`  ${f.id} ${(f.advertiser ?? "?").padEnd(22)} ${f.reason.slice(0, 70)}`);
    }
    console.log(
      "\n⚠️ Do NOT cancel the AdLibrary subscription until these are resolved or accepted as lost.",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
