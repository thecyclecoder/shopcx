/**
 * Multi-page exerciser for the four newly-granted Meta permissions.
 * Walks every row in meta_pages and runs the gating API call against
 * each FB page + IG account so Meta's app-review reviewers see real
 * traffic from each connected asset.
 *
 *   pages_read_user_content   → GET  /{page-id}/conversations
 *   pages_manage_posts        → POST /{page-id}/feed (unpublished) + DELETE
 *   pages_manage_engagement   → POST /{post-id}/likes + DELETE
 *   instagram_content_publish → POST /{ig-user-id}/media (unpublished)
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
const TEST_IMAGE = "https://cdn.shopify.com/s/files/1/0634/9599/5565/files/PDP_Amazing_Coffee.jpg";

function badge(status: number): string {
  if (status >= 200 && status < 300) return "✅ OK ";
  if (status === 400) return "⚠️ 400";
  if (status === 403) return "⚠️ 403";
  return `❌ ${status}`;
}
function preview(s: string, n = 180): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > n ? collapsed.slice(0, n) + "…" : collapsed;
}
async function call(method: "GET" | "POST" | "DELETE", url: string, body?: URLSearchParams) {
  const init: RequestInit = { method };
  if (body) { init.headers = { "Content-Type": "application/x-www-form-urlencoded" }; init.body = body.toString(); }
  const res = await fetch(url, init);
  const text = await res.text();
  console.log(`    ${badge(res.status)}  ${method} ${url.split("?")[0]}`);
  console.log(`            ${preview(text)}`);
  return { status: res.status, body: text };
}

interface MetaPage {
  platform: "facebook" | "instagram";
  meta_page_id: string;
  meta_page_name: string | null;
  meta_instagram_id: string | null;
  access_token_encrypted: string;
}

async function main() {
  const { data: pages } = await admin
    .from("meta_pages")
    .select("platform, meta_page_id, meta_page_name, meta_instagram_id, access_token_encrypted")
    .eq("workspace_id", WS)
    .eq("is_active", true)
    .order("platform")
    .order("meta_page_name");
  if (!pages?.length) { console.log("No connected pages"); return; }
  const { decrypt } = await import("../src/lib/crypto");

  // ── FACEBOOK PAGES ────────────────────────────────────────────
  const fbPages = (pages as MetaPage[]).filter(p => p.platform === "facebook");
  console.log(`\n${"═".repeat(60)}`);
  console.log(`FACEBOOK PAGES (${fbPages.length})`);
  console.log("═".repeat(60));

  for (const p of fbPages) {
    const token = decrypt(p.access_token_encrypted);
    console.log(`\n┌─ ${p.meta_page_name} (${p.meta_page_id})${p.meta_instagram_id ? "  · IG linked" : ""}`);

    console.log("│ pages_read_user_content");
    await call(
      "GET",
      `https://graph.facebook.com/v21.0/${p.meta_page_id}/conversations?fields=participants,updated_time&limit=2&access_token=${encodeURIComponent(token)}`,
    );

    console.log("│ pages_manage_posts");
    const createRes = await call(
      "POST",
      `https://graph.facebook.com/v21.0/${p.meta_page_id}/feed`,
      new URLSearchParams({
        message: `[App-review test ${new Date().toISOString()}] Verifying pages_manage_posts on ${p.meta_page_name}. Unpublished draft, auto-deleted.`,
        published: "false",
        access_token: token,
      }),
    );
    if (createRes.status >= 200 && createRes.status < 300) {
      try {
        const parsed = JSON.parse(createRes.body) as { id?: string };
        if (parsed.id) {
          await new Promise(r => setTimeout(r, 1000));
          await call(
            "DELETE",
            `https://graph.facebook.com/v21.0/${parsed.id}?access_token=${encodeURIComponent(token)}`,
          );
        }
      } catch { /* */ }
    }

    console.log("│ pages_manage_engagement");
    const feedRes = await fetch(`https://graph.facebook.com/v21.0/${p.meta_page_id}/feed?fields=id&limit=1&access_token=${encodeURIComponent(token)}`);
    const feed = (await feedRes.json()) as { data?: { id: string }[] };
    const target = feed.data?.[0]?.id;
    if (!target) {
      console.log("    (skipped — no recent post on this page)");
    } else {
      await call(
        "POST",
        `https://graph.facebook.com/v21.0/${encodeURIComponent(target)}/likes`,
        new URLSearchParams({ access_token: token }),
      );
      await new Promise(r => setTimeout(r, 800));
      await call(
        "DELETE",
        `https://graph.facebook.com/v21.0/${encodeURIComponent(target)}/likes?access_token=${encodeURIComponent(token)}`,
      );
    }
  }

  // ── INSTAGRAM ACCOUNTS ────────────────────────────────────────
  const igAccounts = (pages as MetaPage[]).filter(p => p.platform === "instagram");
  console.log(`\n${"═".repeat(60)}`);
  console.log(`INSTAGRAM ACCOUNTS (${igAccounts.length})`);
  console.log("═".repeat(60));

  for (const p of igAccounts) {
    const token = decrypt(p.access_token_encrypted);
    console.log(`\n┌─ ${p.meta_page_name} (${p.meta_page_id})`);
    console.log("│ instagram_content_publish");
    await call(
      "POST",
      `https://graph.facebook.com/v21.0/${p.meta_page_id}/media`,
      new URLSearchParams({
        image_url: TEST_IMAGE,
        caption: `[App-review test ${new Date().toISOString()}] Unpublished container on ${p.meta_page_name} IG account — expires ~24h, never published to feed.`,
        access_token: token,
      }),
    );
    console.log("    (container unpublished — auto-expires; not posted to feed)");
  }
}
main().catch(e => { console.error(e); process.exit(1); });
