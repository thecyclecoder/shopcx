/**
 * Create a one-off shortlink for an arbitrary target URL and return the
 * absolute short URL on the workspace's shortlink domain (e.g.
 * https://sprfd.co/AB12CD). Reuses the marketing_shortlinks table + the
 * /api/sl/[slug] redirect handler. Returns null when the workspace has no
 * shortlink_domain configured (caller should fall back to the long URL).
 *
 * Used to keep transactional SMS (popup-coupon redeem links) under the 160-char
 * single-segment limit so we don't pay for extra segments.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { generateShortlinkSlug } from "@/lib/shortlink-slug";
import { buildShortlinkUrl } from "@/lib/marketing-coupons";

export async function createShortlink(
  workspaceId: string,
  targetUrl: string,
  opts?: { expiresAt?: string | null },
): Promise<string | null> {
  const admin = createAdminClient();
  for (let i = 0; i < 3; i++) {
    const slug = generateShortlinkSlug(6);
    const { error } = await admin.from("marketing_shortlinks").insert({
      workspace_id: workspaceId,
      slug,
      target_url: targetUrl,
      is_active: true,
      expires_at: opts?.expiresAt ?? null,
    });
    if (!error) return buildShortlinkUrl(workspaceId, slug);
    if (!String(error.message).includes("duplicate")) throw error;
  }
  throw new Error("shortlink slug collision — retry");
}
