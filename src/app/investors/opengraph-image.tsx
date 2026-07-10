import { ImageResponse } from "next/og";

// Branded link-preview card for the /investors area (and its children /investors/
// expired + the /investors/enter magic link, via metadata inheritance). Replaces
// the generic ShopCX preview that confused investors when the SMS/email link
// unfurls in iMessage. A generated PNG (not SVG) so every unfurler renders it.
// See docs/brain/lifecycles/investors-area.md.

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Superfoods — Investor Update";

const GREEN = "#1baf7a";

export default function Image() {
  // A small rising line motif drawn as a normalized polyline over the width.
  const pts = [40, 120, 90, 200, 150, 130, 260, 210, 300, 250, 360, 320, 430]
    .map((v, i, a) => `${(i / (a.length - 1)) * 1120 + 40},${560 - v}`)
    .join(" ");

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "linear-gradient(135deg, #0e2a20 0%, #123a2b 55%, #0b1f18 100%)",
          padding: "64px 72px",
          fontFamily: "sans-serif",
          position: "relative",
        }}
      >
        {/* brand row */}
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 76,
              height: 76,
              borderRadius: 20,
              background: GREEN,
              color: "#04140d",
              fontSize: 46,
              fontWeight: 800,
            }}
          >
            S
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ color: "#ffffff", fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>Superfoods</div>
            <div style={{ color: "#8fd7bf", fontSize: 22, letterSpacing: 3, textTransform: "uppercase" }}>Investor Update</div>
          </div>
        </div>

        {/* headline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ color: "#ffffff", fontSize: 72, fontWeight: 800, lineHeight: 1.05, letterSpacing: -1.5 }}>
            How the business
          </div>
          <div style={{ color: GREEN, fontSize: 72, fontWeight: 800, lineHeight: 1.05, letterSpacing: -1.5 }}>
            is performing.
          </div>
          <div style={{ color: "#a9c8bd", fontSize: 28, marginTop: 8 }}>
            Revenue, profit, and what moves them — live.
          </div>
        </div>

        {/* chart motif + footer */}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ color: "#6f9184", fontSize: 22, letterSpacing: 1 }}>Private &amp; confidential</div>
          <svg width="520" height="150" viewBox="0 0 1200 560" style={{ opacity: 0.9 }}>
            <polyline points={pts} fill="none" stroke={GREEN} strokeWidth={10} strokeLinejoin="round" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    ),
    size,
  );
}
