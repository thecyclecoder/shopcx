import React, { useState } from "react";
import { AbsoluteFill, Img } from "remotion";
import { loadFont as fFraunces } from "@remotion/google-fonts/Fraunces";
import { loadFont as fMontserrat } from "@remotion/google-fonts/Montserrat";

/**
 * Killer static archetype #6 — INGREDIENT BREAKDOWN ("what's inside") poster.
 *
 * Modeled on the erth.labs "THE LONGER YOU DRINK IT, THE MORE IT WORKS" ad
 * Dylan loved: a chunky editorial-serif headline, a split-bag CUTAWAY hero
 * (left = the real bag, right = a cross-section of the ingredients stacked
 * inside), and a vertical ingredient→benefit list with sage-circle line icons.
 *
 * Why it converts the 50+ cold demo: it makes a multi-ingredient functional
 * blend feel substantiated and premium at a glance — every benefit is pinned to
 * a real, named ingredient, so the promise reads as mechanism, not hype. Warm,
 * native, trust-first palette (NOT the loud/brutalist young-scroller template).
 *
 * Parametric on width/height + Meta safe insets (safeTopPct/safeBottomPct) so
 * the SAME component renders 4:5 feed and 9:16 stories/reels. Images use SafeImg
 * (onError-hide + pauseWhenLoading → Lambda-safe).
 *
 * Note: the on-image "Learn more" CTA + caption in the reference are Meta ad-
 * generation artifacts, not part of the creative — so this canvas carries NO
 * baked CTA chip. Meta lays its own over the top at publish.
 */
const fraunces = fFraunces("normal", { weights: ["600", "700", "900"], subsets: ["latin"], ignoreTooManyRequestsWarning: true }).fontFamily;
const mont = fMontserrat("normal", { weights: ["500", "600", "700", "800"], subsets: ["latin"], ignoreTooManyRequestsWarning: true }).fontFamily;

const SafeImg: React.FC<{ src?: string | null; style: React.CSSProperties }> = ({ src, style }) => {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return <Img src={src} style={style} onError={() => setFailed(true)} pauseWhenLoading />;
};

// ── Icon set (white stroke, sits in the sage circle) ──────────────────────────
export type IconKey = "flame" | "bolt" | "shield" | "sun" | "leaf" | "heart" | "brain" | "drop" | "scale";
const Icon: React.FC<{ k: IconKey; s: number }> = ({ k, s }) => {
  const common = { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (k) {
    case "flame": return <svg {...common}><path d="M12 2c1.5 3.5 5 4.5 5 9a5 5 0 0 1-10 0c0-1.7.7-2.8 1.5-3.7C9.8 9 11 7 12 2z" /><path d="M12 13c.8 1 1.5 1.8 1.5 3a1.5 1.5 0 0 1-3 0c0-.9.7-1.6 1.5-3z" /></svg>;
    case "bolt": return <svg {...common}><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" /></svg>;
    case "shield": return <svg {...common}><path d="M12 3 5 6v5c0 4.2 3 7.4 7 9 4-1.6 7-4.8 7-9V6l-7-3z" /><path d="m9 12 2 2 4-4" /></svg>;
    case "sun": return <svg {...common}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" /></svg>;
    case "leaf": return <svg {...common}><path d="M5 20c0-8 5-14 15-15 0 10-6 15-15 15z" /><path d="M5 20c3-5 6-8 11-10" /></svg>;
    case "heart": return <svg {...common}><path d="M12 20.5C6.5 17 3 13.5 3 9.5 3 6.8 5 5 7.3 5c1.7 0 3 1 4.7 3 1.7-2 3-3 4.7-3C19 5 21 6.8 21 9.5c0 4-3.5 7.5-9 11z" /></svg>;
    case "brain": return <svg {...common}><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5 3 3 0 0 0 2 5 3 3 0 0 0 5 0V5a3 3 0 0 0-3-1z" /><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5 3 3 0 0 1-2 5 3 3 0 0 1-5 0" /></svg>;
    case "drop": return <svg {...common}><path d="M12 3c3.5 4.5 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 2.5-6.5 6-11z" /></svg>;
    case "scale": return <svg {...common}><path d="M12 4v16M5 8h14M5 8 3 14a3 3 0 0 0 6 0L7 8M17 8l-2 6a3 3 0 0 0 6 0l-2-6" /></svg>;
    default: return null;
  }
};

export interface BreakdownIngredient { name: string; benefit: string; icon: IconKey }
export interface StaticIngredientBreakdownProps {
  width: number;
  height: number;
  safeTopPct?: number;
  safeBottomPct?: number;
  headline: string;          // chunky serif hook, e.g. "THE LONGER YOU DRINK IT, THE MORE IT WORKS."
  heroImageUrl?: string | null; // the split-bag cutaway composite (Nano Banana)
  ingredients: BreakdownIngredient[]; // up to 6
  productLabel?: string;     // small label floated on the bag, e.g. "Natural Prebiotics"
  ink?: string;              // headline/text color (espresso)
  circle?: string;          // sage circle color
}

export const StaticIngredientBreakdown: React.FC<StaticIngredientBreakdownProps> = (p) => {
  const u = p.width / 1080;
  const ink = p.ink || "#3A2414";
  const circle = p.circle || "#8C9A6B";
  const portrait = p.height / p.width > 1.5;
  const rows = p.ingredients.slice(0, 6);
  const padTop = (p.safeTopPct ?? 0) * p.height;
  const padBottom = (p.safeBottomPct ?? 0) * p.height;

  return (
    <AbsoluteFill style={{ background: "#F4EBDA", fontFamily: mont }}>
      {/* Warm gradient + low golden glow, like the reference's lit-from-behind haze. */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, #F7F0E2 0%, #F0E3C9 46%, #E6C892 84%, #DCB877 100%)" }} />
      <AbsoluteFill style={{ background: "radial-gradient(120% 70% at 50% 96%, rgba(245,214,150,0.85) 0%, rgba(245,214,150,0) 55%)" }} />

      <AbsoluteFill style={{ paddingTop: padTop, paddingBottom: padBottom }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: `${60 * u}px ${44 * u}px ${48 * u}px` }}>
          {/* Headline — chunky bracketed serif, espresso ink, tight leading. */}
          <div style={{ fontFamily: fraunces, fontWeight: 900, color: ink, fontSize: (portrait ? 96 : 92) * u, lineHeight: 0.97, letterSpacing: -1.5 * u, textTransform: "uppercase" }}>
            {p.headline}
          </div>
          {/* Eyebrow — the "12 superfoods" claim, read as an intentional kicker. */}
          {p.productLabel && (
            <div style={{ marginTop: 18 * u, display: "flex", alignItems: "center", gap: 14 * u }}>
              <span style={{ width: 46 * u, height: 4 * u, background: circle, borderRadius: 999 }} />
              <span style={{ fontFamily: mont, fontWeight: 800, fontSize: 34 * u, letterSpacing: 2 * u, textTransform: "uppercase", color: circle }}>{p.productLabel}</span>
            </div>
          )}

          {/* Body: split-bag cutaway (left) + ingredient→benefit list (right). */}
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 18 * u, marginTop: 36 * u, minHeight: 0 }}>
            <div style={{ flex: 1.28, position: "relative", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {/* soft contact shadow on the surface */}
              <div style={{ position: "absolute", bottom: "5%", left: "8%", right: "8%", height: 44 * u, background: "radial-gradient(60% 100% at 50% 50%, rgba(60,36,20,0.32), rgba(60,36,20,0))", filter: `blur(${6 * u}px)` }} />
              <SafeImg src={p.heroImageUrl} style={{ width: "100%", height: "100%", objectFit: "contain", filter: `drop-shadow(0 ${18 * u}px ${30 * u}px rgba(60,36,20,0.28))` }} />
            </div>

            <div style={{ flex: 0.92, display: "flex", flexDirection: "column", justifyContent: "center", gap: (portrait ? 40 : 34) * u }}>
              {rows.map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 26 * u }}>
                  <span style={{ flexShrink: 0, width: 92 * u, height: 92 * u, borderRadius: 999, background: circle, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", boxShadow: `0 ${4 * u}px ${12 * u}px rgba(60,36,20,0.16)` }}>
                    <Icon k={r.icon} s={48 * u} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: mont, fontWeight: 800, fontSize: 44 * u, color: ink, lineHeight: 1.04, textTransform: "uppercase", letterSpacing: -0.3 * u }}>{r.name}</div>
                    <div style={{ fontFamily: mont, fontWeight: 600, fontSize: 38 * u, color: "rgba(58,36,20,0.74)", lineHeight: 1.1 }}>{r.benefit}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
