import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { uploadBuffer, signedUrl } from "@/lib/ad-storage";
import { generateMetaCopy } from "@/lib/ad-meta-copy";
import { generateAdvertorialPagesForCampaign } from "@/lib/advertorial-pages";

// Upload-your-own static ad: skip generation, wrap a finished image into a
// publish-ready campaign (static ad_videos + angle metadata + lander + Meta copy).
type Archetype = "advertorial" | "testimonial" | "authority" | "big_claim" | "before_after";
const ARCHETYPES: Archetype[] = ["advertorial", "testimonial", "authority", "big_claim", "before_after"];
const LANDER_ARCHETYPES: Record<Archetype, "advertorial" | "beforeafter" | "pdp"> = {
  advertorial: "advertorial", before_after: "beforeafter", testimonial: "pdp", authority: "pdp", big_claim: "pdp",
};
// Archetype → angle scaffold (hook formula + LF8 slot). The user's description
// becomes the hook one-liner so the AI copy is grounded in the actual image.
const ANGLE_SCAFFOLD: Record<Archetype, { hook_slug: string; lf8_slot: number }> = {
  advertorial: { hook_slug: "callout", lf8_slot: 6 },
  testimonial: { hook_slug: "results_first", lf8_slot: 6 },
  authority: { hook_slug: "secret_reveal", lf8_slot: 1 },
  big_claim: { hook_slug: "contrarian", lf8_slot: 1 },
  before_after: { hook_slug: "results_first", lf8_slot: 8 },
};
const FORMATS = ["feed_4x5", "stories_9x16"] as const;

async function authorize(workspaceId: string | null) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!workspaceId) return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user, admin };
}

function decodeDataUrl(dataUrl: string): { buffer: Buffer; ext: string; mime: string } | null {
  const m = dataUrl.match(/^data:(image\/(png|jpe?g|webp));base64,(.+)$/);
  if (!m) return null;
  const mime = m[1];
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  return { buffer: Buffer.from(m[3], "base64"), ext, mime };
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;
  const admin = auth.admin;

  const productId: string | undefined = body.productId;
  const archetype: Archetype = body.archetype;
  const description: string = (body.description || "").trim();
  const images: Array<{ format: string; dataUrl: string }> = Array.isArray(body.images) ? body.images : [];

  if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });
  if (!ARCHETYPES.includes(archetype)) return NextResponse.json({ error: "invalid archetype" }, { status: 400 });
  if (!description) return NextResponse.json({ error: "description required" }, { status: 400 });
  const usable = images.filter((i) => FORMATS.includes(i.format as (typeof FORMATS)[number]) && typeof i.dataUrl === "string");
  if (!usable.length) return NextResponse.json({ error: "at least one image (feed_4x5 / stories_9x16) required" }, { status: 400 });

  const [{ data: product }, { data: ws }] = await Promise.all([
    admin.from("products").select("title, handle").eq("id", productId).maybeSingle(),
    admin.from("workspaces").select("storefront_domain, storefront_slug").eq("id", workspaceId as string).maybeSingle(),
  ]);
  if (!product?.handle) return NextResponse.json({ error: "product not found" }, { status: 404 });

  // 1) Angle — archetype scaffold + the description as the hook one-liner.
  const sc = ANGLE_SCAFFOLD[archetype];
  const { data: angle } = await admin
    .from("product_ad_angles")
    .insert({
      workspace_id: workspaceId, product_id: productId,
      hook_slug: sc.hook_slug, lf8_slot: sc.lf8_slot,
      lead_benefit_anchor: description.slice(0, 120),
      hook_one_liner: description.slice(0, 120),
      urgency_lever: "none", generated_by: "imported", is_active: true,
    })
    .select("id").single();

  // 2) Campaign.
  const name = `Upload · ${product.title || "Product"} · ${archetype}`;
  const { data: campaign, error: cErr } = await admin
    .from("ad_campaigns")
    .insert({ workspace_id: workspaceId, product_id: productId, name, angle_id: angle?.id ?? null, status: "ready" })
    .select("id").single();
  if (cErr || !campaign) return NextResponse.json({ error: `campaign: ${cErr?.message}` }, { status: 500 });
  const campaignId = campaign.id;

  // 3) Static ad_videos rows (4:5 + 9:16), uploaded to the ad-tool bucket.
  let canonicalId: string | null = null;
  for (const img of usable) {
    const decoded = decodeDataUrl(img.dataUrl);
    if (!decoded) continue;
    const ins = await admin
      .from("ad_videos")
      .insert({ workspace_id: workspaceId, campaign_id: campaignId, format: img.format, media_kind: "static", format_variant_of_id: canonicalId, status: "pending", meta: { archetype } })
      .select("id").single();
    const vrow = ins.data as { id: string } | null;
    if (!vrow) continue;
    if (!canonicalId) canonicalId = vrow.id;
    const storagePath = `finals/${workspaceId}/${vrow.id}.${decoded.ext}`;
    await uploadBuffer(storagePath, decoded.buffer, decoded.mime);
    const url = await signedUrl(storagePath);
    await admin.from("ad_videos").update({ static_jpg_url: url, status: "ready", meta: { archetype, storage_path: storagePath } }).eq("id", vrow.id);
  }

  // 4) Landing URL — archetype-routed. Lander archetypes generate the page first
  //    (to learn its slug); the rest point at the in-house storefront PDP.
  const base = ws?.storefront_domain
    ? `https://${ws.storefront_domain}/${product.handle}`
    : ws?.storefront_slug ? `https://shopcx.ai/store/${ws.storefront_slug}/${product.handle}` : null;
  const landerKind = LANDER_ARCHETYPES[archetype];
  let landingUrl: string | null = base;
  if (base && landerKind !== "pdp") {
    try {
      const res = await generateAdvertorialPagesForCampaign(workspaceId as string, campaignId);
      const lander = res.landers.find((l) => l.variant === landerKind);
      if (lander) landingUrl = `${base}${lander.url_path}`;
    } catch { /* fall back to PDP */ }
  }
  if (landingUrl) await admin.from("ad_campaigns").update({ landing_url: landingUrl }).eq("id", campaignId).then(undefined, () => {});

  // 5) Pre-generate Meta copy onto the angle so the operator only clicks Publish.
  try {
    const copy = await generateMetaCopy(workspaceId as string, campaignId);
    if (copy && angle?.id) {
      await admin.from("product_ad_angles").update({
        meta_headline: (copy.headlines[0] || "").slice(0, 40),
        meta_primary_text: (copy.primaryTexts[0] || "").slice(0, 125),
        meta_description: (copy.description || "").slice(0, 30),
      }).eq("id", angle.id);
    }
  } catch { /* copy is regenerated at publish if this fails */ }

  return NextResponse.json({ campaignId, landingUrl });
}
