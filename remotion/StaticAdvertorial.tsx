import React, { useState } from "react";
import { AbsoluteFill, Img } from "remotion";
import { loadFont as fPlayfair } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as fInter } from "@remotion/google-fonts/Inter";
import { loadFont as fMontserrat } from "@remotion/google-fonts/Montserrat";

/**
 * Advertorial / editorial "article" static — the highest-converting static
 * format for a COLD 50+ audience. Deliberately the OPPOSITE of AdStatic.tsx's
 * loud/brutalist look: clean off-white page, large legible serif headline,
 * native-article framing, heavy trust signals. Older buyers convert on
 * trust + legibility + "looks like content, not an ad".
 *
 * Compliance: this is a BRAND-owned editorial voice (never impersonates a real
 * news outlet) and carries a clear SPONSORED label — Meta + FTC safe.
 *
 * All copy is passed in (the pipeline generates it via Opus from the Product
 * Intelligence tiers + runs the validator). Hero image uses the SafeImg pattern
 * (onError-hide + pauseWhenLoading) so a flaky signed URL never hard-fails the
 * still — the same fix the Lambda static path needs.
 */

const playfairFF = fPlayfair("normal", { weights: ["700", "800", "900"], subsets: ["latin"], ignoreTooManyRequestsWarning: true }).fontFamily;
const interFF = fInter("normal", { weights: ["400", "500", "600", "700", "800"], subsets: ["latin"], ignoreTooManyRequestsWarning: true }).fontFamily;
const montserratFF = fMontserrat("normal", { weights: ["500", "600", "700", "800"], subsets: ["latin"], ignoreTooManyRequestsWarning: true }).fontFamily;

/**
 * editorial = Playfair serif headline + Inter body (looks like a news article →
 * the conversion mechanism for advertorials). branded = Montserrat throughout
 * (matches storefront font, but reads as a DTC ad). Default editorial.
 */
type FontMode = "editorial" | "branded";

const SafeImg: React.FC<{ src?: string | null; style: React.CSSProperties }> = ({ src, style }) => {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return <Img src={src} style={style} onError={() => setFailed(true)} pauseWhenLoading />;
};

export interface StaticAdvertorialProps {
  width: number;
  height: number;
  /** Editorial masthead — brand-owned, e.g. "THE SUPERFOODS REPORT". */
  publication: string;
  /** "SPONSORED" / "PAID PARTNERSHIP" honesty label. */
  sponsorLabel: string;
  category: string; // e.g. "HEALTH"
  byline: string; // e.g. "By the Editorial Team"
  dateLabel: string; // e.g. "June 2026"
  headline: string; // serif, the curiosity/benefit hook
  dek: string; // one-line standfirst under the headline
  heroImageUrl?: string | null;
  heroCaption?: string;
  body: string[]; // 1-3 short paragraphs, grounded in PI
  rating: number; // 0-5
  reviewCount: string; // e.g. "2,291"
  badges: string[]; // trust chips
  guarantee: string; // short guarantee line
  cta: string; // "Read more →"
  accent: string; // brand accent
  fontMode?: FontMode; // "editorial" (default) | "branded"
  heroHeightPx?: number; // hero box height @1080w (default 300; raise for portrait avatar shots)
  heroObjectPosition?: string; // CSS object-position for the hero crop (default "center")
  /** Meta safe-zone insets as a fraction of height — keeps content clear of the
   *  Stories/Reels top (profile/clock) and bottom (nav/CTA) overlays. 0 for 4:5 feed. */
  safeTopPct?: number;
  safeBottomPct?: number;
}

const Stars: React.FC<{ n: number; size: number }> = ({ n, size }) => (
  <span style={{ fontSize: size, color: "#E8A100", letterSpacing: size * 0.05, lineHeight: 1 }}>
    {"★".repeat(Math.round(n))}
    <span style={{ color: "#D8CFC4" }}>{"★".repeat(5 - Math.round(n))}</span>
  </span>
);

export const StaticAdvertorial: React.FC<StaticAdvertorialProps> = (p) => {
  const u = p.width / 1080; // scale unit
  const accent = p.accent || "#B0451C";
  const branded = p.fontMode === "branded";
  // Serif headline = editorial signal; branded swaps in the storefront sans.
  const playfair = branded ? montserratFF : playfairFF;
  const inter = branded ? montserratFF : interFF;

  const padTop = (p.safeTopPct ?? 0) * p.height;
  const padBottom = (p.safeBottomPct ?? 0) * p.height;

  return (
    <AbsoluteFill style={{ background: "#FBF8F2", fontFamily: inter, color: "#1A140F", display: "flex", flexDirection: "column", paddingTop: padTop, paddingBottom: padBottom }}>
      {/* ── Masthead ───────────────────────────────────────────────── */}
      <div style={{ padding: `${44 * u}px ${64 * u}px ${28 * u}px`, borderBottom: `${2 * u}px solid #1A140F` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ background: "#1A140F", color: "#FBF8F2", fontWeight: 800, fontSize: 22 * u, letterSpacing: 1.5 * u, padding: `${8 * u}px ${16 * u}px`, borderRadius: 4 * u }}>
            {p.sponsorLabel}
          </div>
          <div style={{ fontFamily: playfair, fontWeight: 900, fontSize: 40 * u, letterSpacing: 1 * u, textTransform: "uppercase" }}>
            {p.publication}
          </div>
          <div style={{ fontWeight: 700, fontSize: 24 * u, color: accent, letterSpacing: 2 * u }}>{p.category}</div>
        </div>
      </div>

      {/* ── Article body ───────────────────────────────────────────── */}
      <div style={{ flex: 1, padding: `${36 * u}px ${60 * u}px ${28 * u}px`, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 25 * u, color: "#6B5E52", marginBottom: 14 * u }}>
          {p.byline} · {p.dateLabel}
        </div>

        <div style={{ fontFamily: playfair, fontWeight: 900, fontSize: 66 * u, lineHeight: 1.03, letterSpacing: -1 * u, marginBottom: 18 * u }}>
          {p.headline}
        </div>

        <div style={{ fontWeight: 500, fontSize: 33 * u, lineHeight: 1.28, color: "#473C32", marginBottom: 22 * u }}>
          {p.dek}
        </div>

        {/* Hero image (lifestyle/product). Bordered like an article photo. */}
        {p.heroImageUrl && (
          <div style={{ marginBottom: 12 * u }}>
            <SafeImg src={p.heroImageUrl} style={{ width: "100%", height: (p.heroHeightPx ?? 300) * u, objectFit: "cover", objectPosition: p.heroObjectPosition ?? "center", borderRadius: 12 * u, display: "block" }} />
            {p.heroCaption && (
              <div style={{ fontSize: 20 * u, color: "#8A7C6E", fontStyle: "italic", marginTop: 8 * u }}>{p.heroCaption}</div>
            )}
          </div>
        )}

        {/* Body paragraphs */}
        <div style={{ marginTop: 16 * u, display: "flex", flexDirection: "column", gap: 12 * u }}>
          {p.body.map((para, i) => (
            <div key={i} style={{ fontSize: 31 * u, lineHeight: 1.38, color: "#2B2118" }}>
              {i === 0 ? <span style={{ fontFamily: playfair, fontWeight: 900, fontSize: 50 * u, float: "left", lineHeight: 0.86, marginRight: 12 * u, marginTop: 4 * u, color: accent }}>{para.charAt(0)}</span> : null}
              {i === 0 ? para.slice(1) : para}
            </div>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 16 * u }} />

        {/* ── Proof + trust footer ─────────────────────────────────── */}
        <div style={{ paddingTop: 18 * u, borderTop: `${2 * u}px solid #E3DACB` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 * u, marginBottom: 12 * u }}>
            <Stars n={p.rating} size={36 * u} />
            <span style={{ fontWeight: 800, fontSize: 32 * u }}>{p.rating.toFixed(1)}</span>
            <span style={{ fontWeight: 600, fontSize: 28 * u, color: "#6B5E52" }}>from {p.reviewCount} verified reviews</span>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 * u, marginBottom: 16 * u }}>
            {p.badges.map((b, i) => (
              <span key={i} style={{ border: `${2 * u}px solid #1A140F`, fontWeight: 700, fontSize: 24 * u, padding: `${7 * u}px ${16 * u}px`, borderRadius: 999 }}>✓ {b}</span>
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 * u }}>
            <span style={{ fontWeight: 600, fontSize: 26 * u, color: "#473C32", maxWidth: 540 * u, lineHeight: 1.28 }}>{p.guarantee}</span>
            <span style={{ background: accent, color: "#fff", fontWeight: 800, fontSize: 34 * u, padding: `${18 * u}px ${36 * u}px`, borderRadius: 999, whiteSpace: "nowrap" }}>{p.cta}</span>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
