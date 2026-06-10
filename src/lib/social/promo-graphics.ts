/**
 * AI-generated promo graphics for social campaigns. Given a promo (offer brief
 * + emphasis product), Nano Banana Pro composes a themed sale graphic from the
 * product's isolated image — feed (4:5) + story (9:16). The planner then uses
 * these for feed/story posts during the promo window.
 * See docs/brain/specs/automated-social-scheduler.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { generateNanoBananaProCombine } from "@/lib/gemini";

const RATIOS: { post_type: "feed" | "story"; ratio: string; descr: string; safe: string }[] = [
  { post_type: "feed", ratio: "4:5", descr: "a 4:5 vertical portrait composition", safe: "Fill the frame for an Instagram/Facebook feed post." },
  { post_type: "story", ratio: "9:16", descr: "a tall 9:16 vertical story composition", safe: "Keep the product and all text within the central safe area (away from the very top and bottom) for Stories." },
];

function buildPrompt(brief: string, productTitle: string, descr: string, safe: string): string {
  return `Create a festive, premium PROMOTIONAL SALE graphic for social media, in ${descr}.

HERO: the product in the provided image — "${productTitle}" — displayed large, sharp, fully visible and unobstructed, as the clear centerpiece.

OFFER + THEME: ${brief}
Infer the occasion from the offer and match the whole design to it (e.g. patriotic red/white/blue with fireworks for the Fourth of July; warm tones for fall; festive for the holidays). Clean and high-end, not cluttered.

TEXT (render crisp, large, legible, correctly spelled): a bold headline with the discount/offer, the occasion name, and a small "SHOP NOW" call-to-action button. ${safe}

Eye-catching, scroll-stopping, professional brand quality. No watermark, no extra logos.`;
}

/** Generate + store both promo graphics for a campaign. Idempotent (upsert by path). */
export async function generatePromoGraphics(workspaceId: string, campaignId: string): Promise<{ ok: boolean; count: number; error?: string }> {
  const admin = createAdminClient();
  const { data: camp } = await admin
    .from("social_campaigns")
    .select("name, brief, emphasis_product_id")
    .eq("id", campaignId).eq("workspace_id", workspaceId).maybeSingle();
  if (!camp) return { ok: false, count: 0, error: "campaign not found" };
  if (!camp.emphasis_product_id) return { ok: false, count: 0, error: "no emphasis product" };

  const [{ data: product }, { data: variant }] = await Promise.all([
    admin.from("products").select("title").eq("id", camp.emphasis_product_id).maybeSingle(),
    admin.from("product_variants").select("isolated_image_url").eq("product_id", camp.emphasis_product_id).not("isolated_image_url", "is", null).limit(1).maybeSingle(),
  ]);
  if (!variant?.isolated_image_url) {
    await admin.from("social_campaigns").update({ graphics_status: "failed" }).eq("id", campaignId);
    return { ok: false, count: 0, error: "product has no isolated image" };
  }

  await admin.from("social_campaigns").update({ graphics_status: "generating" }).eq("id", campaignId);
  const productTitle = (product?.title as string) || "our product";
  const media: { post_type: string; ratio: string; url: string }[] = [];

  for (const r of RATIOS) {
    try {
      const { buffer } = await generateNanoBananaProCombine({
        workspaceId,
        prompt: buildPrompt(camp.brief, productTitle, r.descr, r.safe),
        imageUrls: [variant.isolated_image_url as string],
      });
      const path = `workspaces/${workspaceId}/social-promo/${campaignId}/${r.post_type}.jpg`;
      await admin.storage.from("product-media").upload(path, buffer, { contentType: "image/jpeg", upsert: true });
      const { data: pub } = admin.storage.from("product-media").getPublicUrl(path);
      // Cache-bust so a regenerated graphic isn't served stale.
      media.push({ post_type: r.post_type, ratio: r.ratio, url: `${pub.publicUrl}?v=${Date.now()}` });
    } catch (e) {
      console.error(`[promo-graphics] ${r.post_type} failed for ${campaignId}:`, e instanceof Error ? e.message : e);
    }
  }

  await admin.from("social_campaigns").update({
    generated_media: media,
    graphics_status: media.length ? "ready" : "failed",
    updated_at: new Date().toISOString(),
  }).eq("id", campaignId);

  return { ok: media.length > 0, count: media.length };
}
