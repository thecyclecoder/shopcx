import { ImageResponse } from "next/og";
import { headers } from "next/headers";
import { getPageData } from "../_lib/page-data";

export const runtime = "nodejs";
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "Product";

export default async function OpengraphImage({
  params,
}: {
  params: { slug: string };
}) {
  const h = await headers();
  const workspaceSlug = h.get("x-storefront-workspace-slug");

  const data = workspaceSlug
    ? await getPageData(workspaceSlug, params.slug)
    : null;

  const headline =
    data?.page_content?.hero_headline || data?.product.title || "Shop";
  const subhead = data?.page_content?.hero_subheadline || "";
  const image = data?.product.image_url || data?.media_by_slot["hero"]?.url || null;

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          background: "white",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "64px",
            width: image ? "55%" : "100%",
            gap: 24,
          }}
        >
          <div
            style={{
              fontSize: 60,
              fontWeight: 800,
              color: "#18181b",
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
            }}
          >
            {headline}
          </div>
          {subhead && (
            <div style={{ fontSize: 28, color: "#52525b", lineHeight: 1.3 }}>
              {subhead}
            </div>
          )}
        </div>
        {image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt=""
            width={540}
            height={630}
            style={{ objectFit: "cover", width: "45%", height: "100%" }}
          />
        )}
      </div>
    ),
    { ...size },
  );
}
