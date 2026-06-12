/**
 * Organic social publishing — the proven Graph API mechanics (validated by a
 * live test 2026-06-10) for posting feed/reel/story content to Facebook Pages
 * and Instagram. See docs/brain/specs/automated-social-scheduler.md.
 *
 * Low-level functions take explicit tokens + urls. `publishScheduledPost`
 * orchestrates a scheduled_social_posts row end-to-end (token + media resolve
 * + dispatch). Media in the private `ad-tool` bucket is re-signed fresh at
 * publish time so Meta can fetch it; public resource images pass through.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const GRAPH = "https://graph.facebook.com/v21.0";
const SIGNED_URL_TTL = 3600; // 1h — Meta fetches within seconds of the call

type Ok<T> = { ok: true } & T;
/** `retryable` = a transient Graph error (5xx / rate limit / Meta codes 1,2,4…)
 *  the caller should retry with backoff, vs. a permanent failure (bad media,
 *  policy, expired token) that won't succeed on retry. */
type Err = { ok: false; error: string; retryable?: boolean };
export type PublishResult = Ok<{ platformId: string; permalink?: string }> | Err;

async function graphPost(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && !json?.error, status: res.status, json };
}

const graphErr = (json: any, fallback: string) => json?.error?.message || fallback;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is a Graph API failure transient (worth a retry)? Meta flags many with
 *  `is_transient`, plus codes 1 (unknown) / 2 (service down) / 4,17,32,341,613
 *  (rate limits), and any 5xx/429. These are exactly the "An unexpected error
 *  has occurred. Please retry" class that was permanently failing posts. */
function isTransientGraph(status: number, json: any): boolean {
  if (status >= 500 || status === 429) return true;
  const e = json?.error;
  if (e?.is_transient === true) return true;
  return [1, 2, 4, 17, 32, 341, 613].includes(Number(e?.code));
}

/** Build an Err from a Graph response, tagging transient failures retryable. */
function graphFail(r: { status: number; json: any }, fallback: string): Err {
  return { ok: false, error: graphErr(r.json, `${fallback} (${r.status})`), retryable: isTransientGraph(r.status, r.json) };
}

// ── Facebook ──

/** Publish a photo to a Facebook Page feed. */
export async function publishFacebookPhoto(
  pageId: string, pageToken: string, imageUrl: string, caption: string,
): Promise<PublishResult> {
  const r = await graphPost(`${pageId}/photos`, { url: imageUrl, caption, access_token: pageToken });
  if (!r.ok || !r.json?.post_id) return graphFail(r, "FB photo failed");
  return { ok: true, platformId: r.json.post_id, permalink: `https://www.facebook.com/${r.json.post_id}` };
}

// ── Instagram (two-step: create container → publish) ──

async function igPublish(igUserId: string, token: string, creationId: string): Promise<PublishResult> {
  const r = await graphPost(`${igUserId}/media_publish`, { creation_id: creationId, access_token: token });
  if (!r.ok || !r.json?.id) return graphFail(r, "IG publish failed");
  // Best-effort permalink fetch (non-fatal).
  let permalink: string | undefined;
  try {
    const p = await fetch(`${GRAPH}/${r.json.id}?fields=permalink&access_token=${token}`).then((x) => x.json());
    permalink = p?.permalink;
  } catch { /* ignore */ }
  return { ok: true, platformId: r.json.id, permalink };
}

/** Publish a single image to the IG feed. */
export async function publishInstagramImage(
  igUserId: string, token: string, imageUrl: string, caption: string,
): Promise<PublishResult> {
  const c = await graphPost(`${igUserId}/media`, { image_url: imageUrl, caption, access_token: token });
  if (!c.ok || !c.json?.id) return graphFail(c, "IG image container failed");
  return igPublish(igUserId, token, c.json.id);
}

/** Publish a Reel (video). Container processing is async — poll until FINISHED. */
export async function publishInstagramReel(
  igUserId: string, token: string, videoUrl: string, caption: string,
): Promise<PublishResult> {
  const c = await graphPost(`${igUserId}/media`, { media_type: "REELS", video_url: videoUrl, caption, share_to_feed: true, access_token: token });
  if (!c.ok || !c.json?.id) return graphFail(c, "IG reel container failed");
  const creationId = c.json.id;
  // Poll status_code (up to ~2 min) — video transcode takes time.
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const s = await fetch(`${GRAPH}/${creationId}?fields=status_code&access_token=${token}`).then((x) => x.json()).catch(() => ({}));
    if (s?.status_code === "FINISHED") return igPublish(igUserId, token, creationId);
    if (s?.status_code === "ERROR" || s?.status_code === "EXPIRED") return { ok: false, error: `IG reel processing ${s.status_code}` };
  }
  return { ok: false, error: "IG reel processing timed out" };
}

/** Publish a Story (image or video). Stories are media-only — no caption/overlay via the API. */
export async function publishInstagramStory(
  igUserId: string, token: string, mediaUrl: string, isVideo: boolean,
): Promise<PublishResult> {
  const body = isVideo
    ? { media_type: "STORIES", video_url: mediaUrl, access_token: token }
    : { media_type: "STORIES", image_url: mediaUrl, access_token: token };
  const c = await graphPost(`${igUserId}/media`, body);
  if (!c.ok || !c.json?.id) return graphFail(c, "IG story container failed");
  if (isVideo) {
    // Video stories need the same processing poll.
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const s = await fetch(`${GRAPH}/${c.json.id}?fields=status_code&access_token=${token}`).then((x) => x.json()).catch(() => ({}));
      if (s?.status_code === "FINISHED") break;
      if (s?.status_code === "ERROR" || s?.status_code === "EXPIRED") return { ok: false, error: `IG story processing ${s.status_code}` };
    }
  }
  return igPublish(igUserId, token, c.json.id);
}

// ── Media resolution ──

/** Resolve a publishable, publicly-fetchable URL for a scheduled post's media. */
export async function resolveMediaUrl(
  post: { media_url?: string | null; media_bucket?: string | null; media_path?: string | null },
): Promise<string | null> {
  if (post.media_bucket && post.media_path) {
    const admin = createAdminClient();
    const { data } = await admin.storage.from(post.media_bucket).createSignedUrl(post.media_path, SIGNED_URL_TTL);
    return data?.signedUrl || null;
  }
  return post.media_url || null;
}

// ── Orchestration ──

export interface ScheduledPostRow {
  id: string;
  workspace_id: string;
  meta_page_id: string;
  platform: "facebook" | "instagram";
  post_type: "feed" | "reel" | "story";
  caption: string | null;
  media_url: string | null;
  media_bucket: string | null;
  media_path: string | null;
}

/**
 * Publish one scheduled_social_posts row. Resolves the page token + a fresh
 * media URL, dispatches to the right Graph call, and returns the platform id.
 * Pure function over the row — the caller owns DB status updates.
 */
export async function publishScheduledPost(post: ScheduledPostRow): Promise<PublishResult> {
  const admin = createAdminClient();
  const { data: page } = await admin
    .from("meta_pages")
    .select("meta_page_id, meta_instagram_id, access_token_encrypted, platform")
    .eq("id", post.meta_page_id)
    .single();
  if (!page?.access_token_encrypted) return { ok: false, error: "meta_page has no token" };

  let token: string;
  try { token = decrypt(page.access_token_encrypted); } catch { return { ok: false, error: "token decrypt failed" }; }

  const mediaUrl = await resolveMediaUrl(post);
  if (!mediaUrl) return { ok: false, error: "could not resolve media url" };
  const caption = post.caption || "";

  if (post.platform === "facebook") {
    // Only feed photos on FB for now (FB reels/stories are a later add).
    return publishFacebookPhoto(String(page.meta_page_id), token, mediaUrl, caption);
  }

  // Instagram. meta_page_id IS the IG user id for instagram-platform rows.
  const igUserId = String(page.meta_instagram_id || page.meta_page_id);
  const isVideo = post.post_type === "reel";
  switch (post.post_type) {
    case "feed": return publishInstagramImage(igUserId, token, mediaUrl, caption);
    case "reel": return publishInstagramReel(igUserId, token, mediaUrl, caption);
    case "story": return publishInstagramStory(igUserId, token, mediaUrl, isVideo);
    default: return { ok: false, error: `unknown post_type ${post.post_type}` };
  }
}
