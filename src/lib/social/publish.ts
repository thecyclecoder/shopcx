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
import { getOrganicContent } from "@/lib/social/organic-content";

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
  if ([1, 2, 4, 17, 32, 341, 613].includes(Number(e?.code))) return true;
  // 9007 / "Media ID is not available" = the IG container isn't ready yet.
  // Retrying (after a wait) publishes it; it is not a permanent media error.
  return Number(e?.code) === 9007 || /media id is not available/i.test(String(e?.message || ""));
}

/** Wait for an IG media container to reach FINISHED before media_publish.
 *  Image containers are usually ready at once but not always — publishing
 *  too early fails with "Media ID is not available" (~30% of IG posts in
 *  Aug–Oct 2026). Returns null when ready, or an Err on ERROR/EXPIRED/timeout. */
async function waitForContainer(creationId: string, token: string, tries: number, intervalMs: number, label: string): Promise<Err | null> {
  for (let i = 0; i < tries; i++) {
    const s = await fetch(`${GRAPH}/${creationId}?fields=status_code&access_token=${token}`).then((x) => x.json()).catch(() => ({}));
    if (s?.status_code === "FINISHED") return null;
    if (s?.status_code === "ERROR" || s?.status_code === "EXPIRED") return { ok: false, error: `${label} processing ${s.status_code}` };
    await sleep(intervalMs);
  }
  return { ok: false, error: `${label} processing timed out`, retryable: true };
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

/**
 * Publish a Facebook Page link post — renders a clickable card with the link's
 * Open Graph image + title (used for blog posts). The message is the caption;
 * Facebook fetches the preview from the URL itself, so no image upload needed.
 * /feed returns the composed post id in `id` (not `post_id` like /photos).
 */
export async function publishFacebookLink(
  pageId: string, pageToken: string, link: string, message: string,
): Promise<PublishResult> {
  const r = await graphPost(`${pageId}/feed`, { message, link, access_token: pageToken });
  const id = r.json?.id || r.json?.post_id;
  if (!r.ok || !id) return graphFail(r, "FB link post failed");
  return { ok: true, platformId: id, permalink: `https://www.facebook.com/${id}` };
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
  const notReady = await waitForContainer(c.json.id, token, 12, 2500, "IG image");
  if (notReady) return notReady;
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
  const notReady = await waitForContainer(creationId, token, 24, 5000, "IG reel");
  if (notReady) return notReady;
  return igPublish(igUserId, token, creationId);
}

/**
 * Publish a 2–10 slide carousel to the IG feed (nugget slideshows).
 * Two-step per Graph: one child container per image (`is_carousel_item: true`),
 * wait each to FINISHED, create the parent (`media_type: 'CAROUSEL'`, `children`,
 * `caption`), wait it, then media_publish. All slides must share one aspect
 * ratio (we render nuggets at 4:5 1080×1350).
 */
export async function publishInstagramCarousel(
  igUserId: string, token: string, imageUrls: string[], caption: string,
): Promise<PublishResult> {
  if (imageUrls.length < 2 || imageUrls.length > 10) {
    return { ok: false, error: `IG carousel needs 2–10 slides (got ${imageUrls.length})` };
  }
  const childIds: string[] = [];
  for (const url of imageUrls) {
    const c = await graphPost(`${igUserId}/media`, { image_url: url, is_carousel_item: true, access_token: token });
    if (!c.ok || !c.json?.id) return graphFail(c, "IG carousel child container failed");
    const notReady = await waitForContainer(c.json.id, token, 12, 2500, "IG carousel child");
    if (notReady) return notReady;
    childIds.push(c.json.id);
  }
  const parent = await graphPost(`${igUserId}/media`, {
    media_type: "CAROUSEL", children: childIds.join(","), caption, access_token: token,
  });
  if (!parent.ok || !parent.json?.id) return graphFail(parent, "IG carousel parent container failed");
  const notReady = await waitForContainer(parent.json.id, token, 24, 3000, "IG carousel");
  if (notReady) return notReady;
  return igPublish(igUserId, token, parent.json.id);
}

/**
 * Publish a multi-photo post to a Facebook Page feed (the FB rendering of a
 * carousel). Upload each photo unpublished (`published: false`) to get a media
 * fbid, then POST /{page}/feed with `attached_media`.
 */
export async function publishFacebookCarousel(
  pageId: string, pageToken: string, imageUrls: string[], message: string,
): Promise<PublishResult> {
  if (imageUrls.length < 2) return { ok: false, error: `FB carousel needs ≥2 photos (got ${imageUrls.length})` };
  const attached: Array<{ media_fbid: string }> = [];
  for (const url of imageUrls) {
    const up = await graphPost(`${pageId}/photos`, { url, published: false, access_token: pageToken });
    if (!up.ok || !up.json?.id) return graphFail(up, "FB carousel photo upload failed");
    attached.push({ media_fbid: String(up.json.id) });
  }
  const r = await graphPost(`${pageId}/feed`, { message, attached_media: attached, access_token: pageToken });
  const id = r.json?.id || r.json?.post_id;
  if (!r.ok || !id) return graphFail(r, "FB carousel post failed");
  return { ok: true, platformId: id, permalink: `https://www.facebook.com/${id}` };
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
  // Every story container (image too) must be FINISHED before publish.
  const notReady = isVideo
    ? await waitForContainer(c.json.id, token, 24, 5000, "IG story")
    : await waitForContainer(c.json.id, token, 12, 2500, "IG story");
  if (notReady) return notReady;
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

/**
 * Resolve the ordered, publicly-fetchable slide URLs of a carousel row. Carousel
 * rows carry no single media_* asset — their slides live in the linked
 * organic_content row (source_ref_id → organic_content.id). Each slide's private
 * image_bucket/image_path is re-signed fresh (never persisted).
 */
async function resolveCarouselUrls(
  admin: ReturnType<typeof createAdminClient>, workspaceId: string, sourceRefId: string | null | undefined,
): Promise<string[]> {
  if (!sourceRefId) return [];
  const content = await getOrganicContent(admin, workspaceId, sourceRefId);
  if (!content) return [];
  const urls: string[] = [];
  for (const s of content.slides) {
    if (s.image_bucket && s.image_path) {
      const { data } = await admin.storage.from(s.image_bucket).createSignedUrl(s.image_path, SIGNED_URL_TTL);
      if (data?.signedUrl) urls.push(data.signedUrl);
    }
  }
  return urls;
}

// ── Orchestration ──

export interface ScheduledPostRow {
  id: string;
  workspace_id: string;
  meta_page_id: string;
  platform: "facebook" | "instagram";
  post_type: "feed" | "reel" | "story" | "carousel";
  caption: string | null;
  media_url: string | null;
  media_bucket: string | null;
  media_path: string | null;
  source_ref_id?: string | null;  // carousel → organic_content.id
  link_url?: string | null;   // blog posts → FB link card
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

  // Carousel (nugget slideshow) — multi-image, resolved from the linked organic_content row.
  if (post.post_type === "carousel") {
    const urls = await resolveCarouselUrls(admin, post.workspace_id, post.source_ref_id);
    if (urls.length < 2) return { ok: false, error: "carousel has <2 resolvable slides" };
    const caption = post.caption || "";
    if (post.platform === "facebook") {
      return publishFacebookCarousel(String(page.meta_page_id), token, urls, caption);
    }
    const igUserId = String(page.meta_instagram_id || page.meta_page_id);
    return publishInstagramCarousel(igUserId, token, urls, caption);
  }

  const mediaUrl = await resolveMediaUrl(post);
  if (!mediaUrl) return { ok: false, error: "could not resolve media url" };
  const caption = post.caption || "";

  if (post.platform === "facebook") {
    // Blog posts → link card (clickable, uses the article's OG image). Everything
    // else → photo. (FB reels/stories are a later add.)
    if (post.link_url) {
      return publishFacebookLink(String(page.meta_page_id), token, post.link_url, caption);
    }
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
