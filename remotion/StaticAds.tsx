import React, { useState } from "react";
import { AbsoluteFill, Img } from "remotion";
import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";

const anton = loadAnton().fontFamily;
const inter = loadInter({ weights: ["600", "700", "800"], subsets: ["latin"], ignoreTooManyRequestsWarning: true }).fontFamily;

// ── shared ───────────────────────────────────────────────────────────────────
export interface Brand { bg: string; fg: string; accent: string; accentFg: string; muted: string; }

// Img that NEVER crashes the still: on load error it just hides (Lambda renders
// fail hard otherwise — "Error loading image with src"). Pass fresh signed URLs.
const SafeImg: React.FC<{ src?: string | null; style: React.CSSProperties; alt?: string }> = ({ src, style }) => {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return <Img src={src} style={style} onError={() => setFailed(true)} pauseWhenLoading />;
};

const Stars: React.FC<{ n: number; size: number; color: string }> = ({ n, size, color }) => (
  <div style={{ display: "flex", gap: size * 0.12, fontSize: size, color, lineHeight: 1 }}>
    {Array.from({ length: 5 }).map((_, i) => (
      <span key={i} style={{ color: i < n ? color : "#D9CFC6" }}>★</span>
    ))}
  </div>
);

const VerifiedChip: React.FC<{ s: number }> = ({ s }) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap: s * 0.4, background: "#E7F6EC", color: "#1B8A4B", fontFamily: inter, fontWeight: 700, fontSize: s, padding: `${s * 0.35}px ${s * 0.7}px`, borderRadius: 999 }}>
    <span>✔</span> Verified Purchase
  </div>
);

// ── 1. Review screenshot — a premium 5★ testimonial card ─────────────────────
export interface StaticReviewProps { width: number; height: number; brand: Brand; reviewerName: string; rating: number; quote: string; verified: boolean; productTitle: string; productImageUrl?: string | null; }
export const StaticReview: React.FC<StaticReviewProps> = (p) => {
  const u = p.width / 1080; // scale unit
  const initial = (p.reviewerName || "?").trim().charAt(0).toUpperCase();
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${p.brand.bg} 0%, #F1E7DA 100%)`, display: "flex", alignItems: "center", justifyContent: "center", padding: 90 * u }}>
      <div style={{ width: "100%", background: "#fff", borderRadius: 48 * u, padding: 70 * u, boxShadow: `0 ${40 * u}px ${90 * u}px rgba(43,26,18,0.18)` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 28 * u, marginBottom: 40 * u }}>
          <div style={{ width: 110 * u, height: 110 * u, borderRadius: 999, background: p.brand.accent, color: p.brand.accentFg, fontFamily: anton, fontSize: 56 * u, display: "flex", alignItems: "center", justifyContent: "center" }}>{initial}</div>
          <div>
            <div style={{ fontFamily: inter, fontWeight: 800, fontSize: 46 * u, color: p.brand.fg }}>{p.reviewerName}</div>
            <div style={{ marginTop: 10 * u }}><Stars n={p.rating} size={44 * u} color="#FFB400" /></div>
          </div>
        </div>
        <div style={{ fontFamily: inter, fontWeight: 600, fontSize: 60 * u, lineHeight: 1.28, color: p.brand.fg, letterSpacing: -0.5 }}>
          “{p.quote}”
        </div>
        <div style={{ marginTop: 50 * u, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {p.verified ? <VerifiedChip s={30 * u} /> : <span />}
          <div style={{ display: "flex", alignItems: "center", gap: 20 * u }}>
            <SafeImg src={p.productImageUrl} style={{ height: 130 * u, width: 130 * u, objectFit: "contain" }} />
            <div style={{ fontFamily: anton, fontSize: 38 * u, color: p.brand.accent, textTransform: "uppercase", maxWidth: 360 * u, lineHeight: 1 }}>{p.productTitle}</div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── 2. Offer card — bold promo, thumb-stopping ───────────────────────────────
export interface StaticOfferProps { width: number; height: number; brand: Brand; discount: string; subline: string; urgency: string; ctaText: string; productTitle: string; productImageUrl?: string | null; backdropUrl?: string | null; }
export const StaticOffer: React.FC<StaticOfferProps> = (p) => {
  const u = p.width / 1080;
  return (
    <AbsoluteFill style={{ background: p.brand.accent }}>
      {p.backdropUrl && <SafeImg src={p.backdropUrl} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.5 }} />}
      <AbsoluteFill style={{ background: p.backdropUrl ? "linear-gradient(180deg, rgba(224,86,31,0.2), rgba(43,26,18,0.75))" : "transparent" }} />
      <AbsoluteFill style={{ padding: 90 * u, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <div style={{ fontFamily: anton, fontSize: 42 * u, color: p.brand.accentFg, textTransform: "uppercase", letterSpacing: 2 }}>{p.productTitle}</div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <div style={{ display: "inline-block", background: "#FFE14D", color: "#2B1A12", fontFamily: inter, fontWeight: 800, fontSize: 34 * u, padding: `${10 * u}px ${22 * u}px`, borderRadius: 12 * u, marginBottom: 24 * u, textTransform: "uppercase" }}>{p.urgency}</div>
          <div style={{ fontFamily: anton, fontSize: 320 * u, lineHeight: 0.82, color: "#fff", textShadow: `0 ${10 * u}px 0 rgba(0,0,0,0.18)` }}>{p.discount}</div>
          <div style={{ fontFamily: anton, fontSize: 96 * u, lineHeight: 1, color: "#FFE14D", marginTop: 8 * u, textTransform: "uppercase" }}>{p.subline}</div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 16 * u, background: "#fff", color: p.brand.accent, fontFamily: anton, fontSize: 56 * u, padding: `${22 * u}px ${44 * u}px`, borderRadius: 999, textTransform: "uppercase" }}>{p.ctaText} →</div>
          <SafeImg src={p.productImageUrl} style={{ height: 560 * u, width: 460 * u, objectFit: "contain", filter: `drop-shadow(0 ${24 * u}px ${40 * u}px rgba(0,0,0,0.35))` }} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── 3. Benefit stack / authority — clean editorial ───────────────────────────
export interface StaticBenefitAuthorityProps { width: number; height: number; brand: Brand; mode: "benefits" | "authority"; productTitle: string; productImageUrl?: string | null; benefits: string[]; expert: { name: string; title: string; quote: string; bullets: string[] } | null; }
export const StaticBenefitAuthority: React.FC<StaticBenefitAuthorityProps> = (p) => {
  const u = p.width / 1080;
  const authority = p.mode === "authority" && p.expert;
  return (
    <AbsoluteFill style={{ background: p.brand.bg, padding: 90 * u, display: "flex", flexDirection: "column" }}>
      <div style={{ fontFamily: anton, fontSize: 44 * u, color: p.brand.accent, textTransform: "uppercase", letterSpacing: 2 }}>{p.productTitle}</div>

      {authority ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 40 * u }}>
          <div style={{ display: "flex", alignItems: "center", gap: 28 * u }}>
            <div style={{ width: 130 * u, height: 130 * u, borderRadius: 999, background: p.brand.accent, color: "#fff", fontFamily: anton, fontSize: 64 * u, display: "flex", alignItems: "center", justifyContent: "center" }}>{(p.expert!.name || "?").charAt(0)}</div>
            <div>
              <div style={{ fontFamily: inter, fontWeight: 800, fontSize: 52 * u, color: p.brand.fg }}>{p.expert!.name}</div>
              <div style={{ fontFamily: inter, fontWeight: 600, fontSize: 34 * u, color: p.brand.muted }}>{p.expert!.title}</div>
            </div>
          </div>
          <div style={{ fontFamily: inter, fontWeight: 600, fontSize: 58 * u, lineHeight: 1.3, color: p.brand.fg }}>“{p.expert!.quote.length > 220 ? p.expert!.quote.slice(0, 219) + "…" : p.expert!.quote}”</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 * u }}>
            {p.expert!.bullets.slice(0, 3).map((b, i) => (
              <div key={i} style={{ background: "#fff", border: `2px solid ${p.brand.accent}`, color: p.brand.fg, fontFamily: inter, fontWeight: 700, fontSize: 32 * u, padding: `${12 * u}px ${24 * u}px`, borderRadius: 999 }}>✓ {b}</div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 30 * u }}>
          <div style={{ fontFamily: anton, fontSize: 96 * u, lineHeight: 0.95, color: p.brand.fg, textTransform: "uppercase" }}>Why it works</div>
          {p.benefits.slice(0, 5).map((b, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 24 * u }}>
              <div style={{ width: 66 * u, height: 66 * u, borderRadius: 999, background: p.brand.accent, color: "#fff", fontFamily: anton, fontSize: 38 * u, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</div>
              <div style={{ fontFamily: inter, fontWeight: 700, fontSize: 52 * u, color: p.brand.fg }}>{b}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <SafeImg src={p.productImageUrl} style={{ height: 360 * u, width: 360 * u, objectFit: "contain" }} />
      </div>
    </AbsoluteFill>
  );
};
