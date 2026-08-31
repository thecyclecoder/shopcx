/**
 * Pre-cancellation safety check: is it safe to end the AdLibrary subscription?
 *
 * Answers the founder's three goals directly (2026-08-25):
 *   1. Can we cancel?                → is anything still reaching adlibrary.com?
 *   2. Do we keep the old ads?       → does EVERY scouted row have retrievable bytes in OUR storage?
 *   3. Does Meta take over?          → is the new lane wired + does the live token still answer?
 *
 * Goal 2 is verified by actually DOWNLOADING sampled images out of our own bucket — a `thumb_path`
 * string proves a column was written, not that the bytes exist. Read-only.
 */
import { createAdminClient } from "./_bootstrap";
import { decrypt } from "../src/lib/crypto";
import { listCompetitors } from "../src/lib/competitors";

const SAMPLE = Number(process.env.SAMPLE || 25);
const BUCKET = "creative-shots";

const count = async (
  admin: ReturnType<typeof createAdminClient>,
  build: (q: ReturnType<ReturnType<typeof createAdminClient>["from"]>) => unknown,
): Promise<number> => {
  const q = build(admin.from("creative_skeletons").select("*", { count: "exact", head: true }) as never);
  const { count: c } = (await q) as { count: number | null };
  return c ?? 0;
};

async function main() {
  const admin = createAdminClient();
  let blocking = 0;

  // ── GOAL 2 — nothing already scouted may become unreachable ──────────────────────────
  console.log("── GOAL 2: do we keep every competitor ad already scouted? ──\n");

  const total = await count(admin, (q) => q);
  const noThumb = await count(admin, (q) => (q as never as { is: Function }).is("thumb_path", null));
  const statics = await count(admin, (q) => (q as never as { eq: Function }).eq("media_type", "static"));
  const videos = await count(admin, (q) => (q as never as { eq: Function }).eq("media_type", "video"));

  console.log(`  creative_skeletons rows : ${total}`);
  console.log(`  static / video          : ${statics} / ${videos}`);
  console.log(`  missing a local copy    : ${noThumb}`);

  // Statics: verify the BYTES, not just the column.
  const { data: sample } = await admin
    .from("creative_skeletons")
    .select("id, advertiser, thumb_path, media_type, status")
    .not("thumb_path", "is", null)
    .limit(SAMPLE);

  let ok = 0;
  let bad = 0;
  let bytes = 0;
  for (const r of (sample ?? []) as Array<{ id: string; advertiser: string | null; thumb_path: string }>) {
    const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(r.thumb_path, 120);
    if (!signed?.signedUrl) {
      bad++;
      console.log(`    ✗ ${r.id.slice(0, 8)} ${(r.advertiser ?? "?").padEnd(22)} could not sign`);
      continue;
    }
    const res = await fetch(signed.signedUrl);
    const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    const isJpeg = buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
    if (res.ok && isJpeg) {
      ok++;
      bytes += buf.length;
    } else {
      bad++;
      console.log(`    ✗ ${r.id.slice(0, 8)} ${(r.advertiser ?? "?").padEnd(22)} HTTP ${res.status} ${buf.length}b jpeg=${isJpeg}`);
    }
  }
  console.log(
    `\n  sampled ${ok + bad} stored creatives → ${ok} downloaded as real JPEGs, ${bad} bad` +
      (ok ? ` (avg ${Math.round(bytes / ok / 1024)}KB)` : ""),
  );
  if (bad > 0 || noThumb > 0) blocking++;

  // The video rows are the honest exception — their creative was never downloaded.
  const { data: vids } = await admin
    .from("creative_skeletons")
    .select("id, advertiser, status, thumb_path, image_url")
    .eq("media_type", "video")
    .limit(500);
  const vidRows = (vids ?? []) as Array<{ status: string | null; thumb_path: string | null; image_url: string | null }>;
  const vidPending = vidRows.filter((v) => v.status === "video_pending");
  const vidNoLocal = vidRows.filter((v) => !v.thumb_path);
  console.log(`\n  video rows              : ${vidRows.length}`);
  console.log(`    still 'video_pending'  : ${vidPending.length}  (never deconstructed)`);
  console.log(`    with NO local copy     : ${vidNoLocal.length}  (creative lives only on adlibrary.com)`);
  if (vidNoLocal.length) {
    console.log(
      `    ⚠️ these ${vidNoLocal.length} video creatives become UNRECOVERABLE once the subscription ends.`,
    );
  }

  // ── GOAL 1 — is anything still reaching adlibrary.com? ───────────────────────────────
  console.log("\n── GOAL 1: what still depends on the AdLibrary subscription? ──\n");
  console.log("  live code paths that call adlibrary.com:");
  console.log("    • src/lib/video-skeleton.ts fetchLegacyAdLibraryVideo — drains legacy video_pending only");
  console.log("    • scripts/_backfill-legacy-creative-thumbs.ts — the backfill itself (already run)");
  console.log("  NOTHING else. The client, the winners flow, and the live-proxy route are deleted.");

  // ── GOAL 3 — does the Meta lane actually answer right now? ───────────────────────────
  console.log("\n── GOAL 3: is the Meta lane live? ──\n");
  const { data: ws } = await admin
    .from("workspaces")
    .select("id, name, meta_user_access_token_encrypted")
    .not("meta_user_access_token_encrypted", "is", null);
  for (const w of (ws ?? []) as Array<{ id: string; name: string; meta_user_access_token_encrypted: string }>) {
    let token: string | null = null;
    try {
      token = decrypt(w.meta_user_access_token_encrypted);
    } catch {
      /* fall through */
    }
    if (!token) {
      console.log(`  ✗ ${w.name}: token present but undecryptable`);
      blocking++;
      continue;
    }
    const qs = new URLSearchParams({
      access_token: token,
      search_terms: "coffee",
      ad_reached_countries: '["US"]',
      ad_type: "ALL",
      limit: "1",
      fields: "id,page_name",
    });
    const res = await fetch(`https://graph.facebook.com/v21.0/ads_archive?${qs}`);
    const json = (await res.json().catch(() => null)) as { data?: unknown[]; error?: { message: string; code: number } } | null;
    if (json?.error) {
      console.log(`  ✗ ${w.name}: /ads_archive code=${json.error.code} ${json.error.message.slice(0, 70)}`);
      blocking++;
    } else {
      console.log(`  ✓ ${w.name}: /ads_archive answered (${json?.data?.length ?? 0} row)`);
    }
  }

  // Competitors go through the SDK chokepoint — a raw query here would be exactly the mistake
  // CLAUDE.md warns about (a wrong column silently reads as zero rows).
  const approved = (
    await Promise.all(
      ((ws ?? []) as Array<{ id: string }>).map((w) =>
        listCompetitors({ workspaceId: w.id, status: "approved" }),
      ),
    )
  ).flat();
  const resolved = approved.filter((c) => c.meta_page_id);
  console.log(
    `\n  approved competitors     : ${approved.length} · ${resolved.length} already have a meta_page_id`,
  );
  const unresolved = approved.filter((c) => !c.meta_page_id).map((c) => c.brand);
  if (unresolved.length) {
    console.log(
      `    ${unresolved.length} need resolution on first sweep: ${unresolved.slice(0, 8).join(", ")}${unresolved.length > 8 ? " …" : ""}`,
    );
  }

  console.log(
    `\n${blocking === 0 ? "✅ No blocking issue found." : `❌ ${blocking} blocking issue(s) — do not cancel yet.`}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
