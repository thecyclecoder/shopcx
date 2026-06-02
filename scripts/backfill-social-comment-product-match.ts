/**
 * Backfill matched_product_id on social_comments rows that previously
 * fell through the matcher. Triggered by the l.facebook.com unwrap
 * we just shipped — every ad post with a Facebook link shim was
 * unmatchable before today.
 *
 * Strategy per row:
 *   1. Load post URLs (from meta_post_cache.extracted_urls if cached,
 *      else fetch the post via Meta API on the page's token)
 *   2. Run them through resolvePostProductMatch — now unwraps
 *      l.facebook.com/l.php and l.instagram.com/l.php
 *   3. Update both the social_comments row + the meta_post_cache
 *      row so the orchestrator + the dashboard sidebar both reflect
 *      the new match
 *
 * Idempotent. Skips rows that already have a match.
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const GRAPH_VERSION = "v21.0";

interface PostAttachment {
  target?: { url?: string };
  url?: string;
  subattachments?: { data?: PostAttachment[] };
}
interface PostMeta {
  message?: string;
  attachments?: { data?: PostAttachment[] };
}

function extractUrlsFromText(text: string): string[] {
  const urls: string[] = [];
  const re = /https?:\/\/[^\s<>"']+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) urls.push(m[0]);
  return urls;
}

async function fetchPostUrls(token: string, postId: string): Promise<string[]> {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(postId)}?fields=message,attachments{type,url,target,subattachments}&access_token=${encodeURIComponent(token)}`
  );
  if (!res.ok) return [];
  const data = (await res.json()) as PostMeta;
  const urls = extractUrlsFromText(data.message || "");
  for (const att of data.attachments?.data || []) {
    if (att.target?.url) urls.push(att.target.url);
    if (att.url) urls.push(att.url);
    for (const sub of att.subattachments?.data || []) {
      if (sub.target?.url) urls.push(sub.target.url);
    }
  }
  return [...new Set(urls)];
}

async function main() {
  const { resolvePostProductMatch } = await import("../src/lib/meta-product-match");
  const { decrypt } = await import("../src/lib/crypto");

  // Index page tokens by page UUID for cheap lookup
  const { data: pageRows } = await admin
    .from("meta_pages")
    .select("id, meta_page_id, access_token_encrypted")
    .eq("workspace_id", WS)
    .eq("platform", "facebook");
  const pageById = new Map((pageRows || []).map(p => [p.id as string, {
    metaPageId: p.meta_page_id as string,
    token: decrypt(p.access_token_encrypted as string),
  }]));
  console.log(`indexed ${pageById.size} FB page(s) with tokens`);

  // All comments with no matched product
  const { data: comments } = await admin
    .from("social_comments")
    .select("id, meta_post_id, meta_page_id, body")
    .eq("workspace_id", WS)
    .is("matched_product_id", null);
  console.log(`unmatched social_comments: ${comments?.length || 0}\n`);

  let matched = 0;
  let stillNull = 0;
  let errors = 0;
  const cachedUrlsByPost = new Map<string, string[] | null>();

  for (const c of comments || []) {
    if (!c.meta_post_id) { stillNull++; continue; }
    const page = pageById.get(c.meta_page_id as string);
    if (!page) { stillNull++; continue; }

    // Try cached URLs first (cheaper); fall back to live fetch.
    let urls = cachedUrlsByPost.get(c.meta_post_id as string) || null;
    if (urls === null) {
      const { data: cache } = await admin
        .from("meta_post_cache")
        .select("extracted_urls")
        .eq("workspace_id", WS)
        .eq("meta_post_id", c.meta_post_id as string)
        .maybeSingle();
      urls = (cache?.extracted_urls as string[] | null) || null;
      if (!urls || urls.length === 0) {
        try {
          urls = await fetchPostUrls(page.token, c.meta_post_id as string);
        } catch (e) {
          console.warn(`  ! ${c.id} fetch post failed:`, e instanceof Error ? e.message : e);
          errors++;
          urls = [];
        }
      }
      cachedUrlsByPost.set(c.meta_post_id as string, urls);
    }
    if (!urls.length) { stillNull++; continue; }

    const productId = await resolvePostProductMatch(admin, WS, urls);
    if (!productId) { stillNull++; continue; }

    await admin.from("social_comments").update({
      matched_product_id: productId,
      updated_at: new Date().toISOString(),
    }).eq("id", c.id);

    // Also update the post-cache row so future comments on the same
    // post don't re-fetch / re-match — and the dashboard sidebar's
    // product chip starts showing immediately.
    await admin.from("meta_post_cache").update({
      matched_product_id: productId,
      extracted_urls: urls,
    }).eq("workspace_id", WS).eq("meta_post_id", c.meta_post_id as string);

    console.log(`  ✓ ${c.id}  post ${c.meta_post_id}  → product ${productId}`);
    matched++;
  }

  console.log(`\nDone — matched ${matched}, still null ${stillNull}, errors ${errors}`);
}
main().catch(e => { console.error(e); process.exit(1); });
