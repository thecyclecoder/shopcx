// Research › Ads — the "Generate ad" button endpoint. Owner-only POST that fires ONE Dahlia/Max
// box-session ad generation for a hero product at a chosen audience temperature, via the
// ad-creative-trigger SDK. The SDK ONLY ever enqueues kind='ad-creative-copy-author' — the box-session
// path that runs the 5 psychological treatments (LF8 / Schwartz / Cialdini / Hopkins / Sugarman) + Max
// copy-QC — never the deterministic `buildMetaCopyPack` node path. So a self-service generate from the
// dashboard can only ever produce a real Dahlia/Max creative. Owner/admin gate mirrors the sibling
// /api/ads/* routes (advertised-products / creative-finder). See [[../../../../docs/brain/dashboard/research__ads]]
// + [[../../../../docs/brain/libraries/ad-creative-trigger]].
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAdvertisedProductIds } from "@/lib/advertised-products";
import { triggerAdGeneration, type AdAudienceTemperature } from "@/lib/ads/ad-creative-trigger";

const TEMPERATURES: readonly AdAudienceTemperature[] = ["cold", "warm", "hot"] as const;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    workspaceId?: string;
    productId?: string;
    temperature?: string;
  };
  const workspaceId = body.workspaceId;
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  // Owner/admin gate — same shape as /api/ads/advertised-products + /api/ads/creative-finder.
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = (member as { role?: string } | null)?.role;
  if (role !== "owner" && role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const productId = body.productId;
  if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });
  // Gate to a hero (advertised) product — mirrors runAdCreativeLoop's own is_advertised gate so a
  // non-hero / attachment SKU can never earn a manual generation.
  const advertised = new Set(await listAdvertisedProductIds(admin, workspaceId));
  if (!advertised.has(productId)) {
    return NextResponse.json({ error: "not an advertised (hero) product" }, { status: 400 });
  }

  // Temperature scopes the box session's winner research + angle selection (cold prospecting vs
  // warm/hot). Default cold — the bin's test-to-find-winner default.
  const temperature: AdAudienceTemperature = TEMPERATURES.includes(body.temperature as AdAudienceTemperature)
    ? (body.temperature as AdAudienceTemperature)
    : "cold";

  const result = await triggerAdGeneration(admin, {
    workspaceId,
    productId,
    temperature,
    reason: "ceo-manual-research-ads-generate",
  });
  return NextResponse.json({ ok: true, jobId: result.jobId, productId, temperature });
}
