/**
 * One-time backfill: mirror Klaviyo-hosted review photos into our own
 * `product-media` bucket before the Klaviyo account goes dark
 * (klaviyo-sunset, Phase A).
 *
 * `product_reviews.images` holds paths in Klaviyo's own shape —
 * `{company_id}/{uuid}.jpg?updated_at=…`, e.g.
 * `JBF4n4/ffe142c2-….jpg?updated_at=2024…` — NOT absolute URLs. Nothing in the
 * app renders them today (there is no `<img>` anywhere that resolves this
 * shape), so no surface breaks when the account lapses. What we lose is the
 * asset itself: ~95 reviews' customer photos, which the in-house reviews
 * program would want as social proof and which cannot be re-fetched once the
 * account is gone.
 *
 * ⚠️ **Needs the CDN base to be supplied.** Klaviyo's API returns the relative
 * path only, and the public review-media host is not documented / not
 * guessable (every candidate base returns S3 `AccessDenied`). Get it from the
 * Klaviyo dashboard while the account is alive: open a review with a photo in
 * their review moderation screen, right-click the image → Copy image address,
 * and pass everything before the `{company_id}/` segment:
 *
 *   npx tsx scripts/_backfill-review-images-to-storage.ts --base https://<host>/<prefix>/
 *   npx tsx scripts/_backfill-review-images-to-storage.ts --base https://<host>/<prefix>/ --apply
 *
 * Dry-run by default: reports what it would mirror and probes the first image
 * so a wrong base fails loudly in one call instead of 95. `--apply` downloads
 * each photo, uploads it to `product-media/review-images/{reviewId}/{n}.{ext}`,
 * and rewrites `product_reviews.images` to the resulting public URLs.
 *
 * **Idempotent + resumable.** A row whose `images` are already absolute URLs on
 * our own storage host is skipped, so re-running (or the ship-time backfill
 * ledger re-running it on the box) is a no-op. Per the ship-time
 * backfill-must-be-tracked convention this ships as a `scripts/_backfill-*.ts`
 * so it is auto-ledgered rather than depending on someone remembering it.
 */
import { loadEnv, createAdminClient } from "./_bootstrap";

loadEnv();

const WORKSPACE_ID = process.env.WORKSPACE_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BUCKET = "product-media";
const APPLY = process.argv.includes("--apply");
const BASE = (() => {
  const i = process.argv.indexOf("--base");
  return i !== -1 ? process.argv[i + 1] : null;
})();

/** Already-mirrored rows carry absolute URLs; Klaviyo rows are relative paths. */
function isMirrored(images: string[]): boolean {
  return images.every((p) => /^https?:\/\//.test(p));
}

function extensionOf(path: string): string {
  const clean = path.split("?")[0];
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? "jpg" : clean.slice(dot + 1).toLowerCase();
}

function contentTypeFor(ext: string): string {
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

async function main(): Promise<void> {
  const admin = createAdminClient();

  const { data: rows, error } = await admin
    .from("product_reviews")
    .select("id, images")
    .eq("workspace_id", WORKSPACE_ID)
    .not("images", "eq", "{}");
  if (error) throw new Error(`read product_reviews failed: ${error.message}`);

  const pending = (rows || []).filter(
    (r) => Array.isArray(r.images) && r.images.length > 0 && !isMirrored(r.images),
  );

  console.log(`rows with images: ${rows?.length ?? 0}`);
  console.log(`already mirrored: ${(rows?.length ?? 0) - pending.length}`);
  console.log(`to mirror:        ${pending.length}`);

  if (pending.length === 0) {
    console.log("✅ nothing to do");
    return;
  }

  if (!BASE) {
    console.log(
      `\n⚠️  no --base supplied — cannot resolve Klaviyo's relative image paths.` +
        `\n   Sample path: ${pending[0].images[0]}` +
        `\n   See this file's header for how to read the CDN base off the Klaviyo dashboard.`,
    );
    return;
  }

  // Probe once so a wrong base fails on call 1, not call 95.
  const probeUrl = BASE.replace(/\/$/, "/") + pending[0].images[0];
  const probe = await fetch(probeUrl);
  if (!probe.ok || !(probe.headers.get("content-type") || "").startsWith("image")) {
    console.error(
      `\n❌ probe failed: ${probe.status} ${probe.headers.get("content-type")}\n   ${probeUrl}` +
        `\n   The --base is wrong — nothing was written.`,
    );
    process.exit(1);
  }
  console.log(`✅ probe ok — ${probeUrl}`);

  if (!APPLY) {
    console.log("\n(dry run — re-run with --apply to download + upload + rewrite)");
    return;
  }

  let mirrored = 0;
  let failed = 0;

  for (const row of pending) {
    const urls: string[] = [];
    for (let i = 0; i < row.images.length; i++) {
      const relative = row.images[i];
      try {
        const res = await fetch(BASE.replace(/\/$/, "/") + relative);
        if (!res.ok) throw new Error(`download ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const ext = extensionOf(relative);
        const objectPath = `review-images/${row.id}/${i}.${ext}`;

        const { error: upErr } = await admin.storage
          .from(BUCKET)
          .upload(objectPath, buf, { contentType: contentTypeFor(ext), upsert: true });
        if (upErr) throw new Error(`upload ${upErr.message}`);

        urls.push(admin.storage.from(BUCKET).getPublicUrl(objectPath).data.publicUrl);
      } catch (err) {
        console.error(`  ✗ ${row.id}[${i}] ${(err as Error).message}`);
        failed++;
      }
    }

    // Only rewrite when every image on the row survived — a partial rewrite
    // would drop the un-mirrored originals with no way back.
    if (urls.length === row.images.length) {
      const { error: updErr } = await admin
        .from("product_reviews")
        .update({ images: urls })
        .eq("id", row.id)
        .eq("workspace_id", WORKSPACE_ID);
      if (updErr) {
        console.error(`  ✗ ${row.id} rewrite: ${updErr.message}`);
        failed++;
      } else {
        mirrored++;
      }
    }
  }

  console.log(`\n✅ mirrored ${mirrored} review(s); ${failed} failure(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
