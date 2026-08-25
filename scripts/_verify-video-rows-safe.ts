/** Targeted check: are the 64 legacy VIDEO rows fully preserved locally + already analyzed? */
import { createAdminClient } from "./_bootstrap";

async function main() {
  const admin = createAdminClient();
  const { data } = await admin
    .from("creative_skeletons")
    .select("id, advertiser, status, thumb_path, hook, mechanism_claim, visioned_at")
    .eq("media_type", "video")
    .limit(500);
  const rows = (data ?? []) as Array<{
    id: string; advertiser: string | null; status: string | null;
    thumb_path: string | null; hook: string | null; visioned_at: string | null;
  }>;

  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status ?? "?", (byStatus.get(r.status ?? "?") ?? 0) + 1);
  console.log(`video rows: ${rows.length}`);
  console.log(`  status: ${[...byStatus.entries()].map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  console.log(`  with a hook (analyzed): ${rows.filter((r) => r.hook).length}`);
  console.log(`  with thumb_path       : ${rows.filter((r) => r.thumb_path).length}`);

  let ok = 0, bad = 0;
  for (const r of rows.filter((x) => x.thumb_path).slice(0, 10)) {
    const { data: signed } = await admin.storage.from("creative-shots").createSignedUrl(r.thumb_path!, 120);
    if (!signed?.signedUrl) { bad++; continue; }
    const res = await fetch(signed.signedUrl);
    const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    if (res.ok && buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) ok++;
    else { bad++; console.log(`    ✗ ${r.id.slice(0, 8)} ${(r.advertiser ?? "?")} HTTP ${res.status} ${buf.length}b`); }
  }
  console.log(`  sampled ${ok + bad} video thumbs → ${ok} valid JPEG, ${bad} bad`);
}
main().catch((e) => { console.error(e); process.exit(1); });
