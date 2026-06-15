import React, { useState } from "react";
import { AbsoluteFill, Img } from "remotion";
import { loadFont as fMontserrat } from "@remotion/google-fonts/Montserrat";

/**
 * Cold-50+ static archetypes (branded — Montserrat, the storefront font). These
 * are overt brand creative, unlike the editorial advertorial (StaticAdvertorial.tsx,
 * which is deliberately un-branded serif). Each is parametric on width/height and
 * accepts Meta safe-zone insets (safeTopPct/safeBottomPct) so the SAME component
 * renders 4:5 feed and 9:16 stories/reels.
 *
 * Archetypes: Testimonial(face) · Authority(face) · BigClaim · BeforeAfter.
 * Trust-first design for older buyers: big legible type, high contrast, one idea,
 * one CTA. Images use SafeImg (onError-hide + pauseWhenLoading → Lambda-safe).
 *
 * Honesty: generated faces are LIFESTYLE models, never attributed as the specific
 * named reviewer. Real review text + name + verified badge stay accurate.
 */
const mont = fMontserrat("normal", { weights: ["500", "600", "700", "800", "900"], subsets: ["latin"], ignoreTooManyRequestsWarning: true }).fontFamily;

const SafeImg: React.FC<{ src?: string | null; style: React.CSSProperties }> = ({ src, style }) => {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return <Img src={src} style={style} onError={() => setFailed(true)} pauseWhenLoading />;
};

const Stars: React.FC<{ n: number; size: number }> = ({ n, size }) => (
  <span style={{ fontSize: size, color: "#FFB400", letterSpacing: size * 0.06, lineHeight: 1 }}>
    {"★".repeat(Math.round(n))}<span style={{ color: "#E4D9CB" }}>{"★".repeat(5 - Math.round(n))}</span>
  </span>
);

const VerifiedTag: React.FC<{ s: number }> = ({ s }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: s * 0.4, color: "#1B8A4B", fontFamily: mont, fontWeight: 700, fontSize: s }}>
    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: s * 1.5, height: s * 1.5, borderRadius: 999, background: "#1B8A4B", color: "#fff", fontSize: s * 0.9 }}>✓</span>
    Verified Buyer
  </span>
);

const TrustChips: React.FC<{ badges: string[]; u: number; dark?: boolean }> = ({ badges, u, dark }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 * u }}>
    {badges.map((b, i) => (
      <span key={i} style={{ border: `${2 * u}px solid ${dark ? "rgba(255,255,255,0.6)" : "#1A140F"}`, color: dark ? "#fff" : "#1A140F", fontFamily: mont, fontWeight: 700, fontSize: 24 * u, padding: `${7 * u}px ${16 * u}px`, borderRadius: 999 }}>✓ {b}</span>
    ))}
  </div>
);

interface Common { width: number; height: number; safeTopPct?: number; safeBottomPct?: number; accent?: string; badges: string[]; cta: string; }
const frame = (p: Common) => ({ paddingTop: (p.safeTopPct ?? 0) * p.height, paddingBottom: (p.safeBottomPct ?? 0) * p.height });

// ── 1. Testimonial (face) ─────────────────────────────────────────────────────
export interface StaticTestimonialProps extends Common { brandBg: string; quote: string; body?: string; reviewerName: string; verified: boolean; faceImageUrl?: string | null; productImageUrl?: string | null; productTitle: string; reviewCount: string; }
export const StaticTestimonial: React.FC<StaticTestimonialProps> = (p) => {
  const u = p.width / 1080; const accent = p.accent || "#B0451C";
  // Portrait (9:16) is far taller than the content needs → centering left a dead
  // gap in the middle. Header / GROWING centered middle / footer distributes the
  // whitespace, the quote bumps up, and the product anchors the mid-frame so it
  // reads full, not sparse.
  const portrait = p.height / p.width > 1.5;
  const quoteSize = (portrait ? 88 : 76) * u;
  return (
    <AbsoluteFill style={{ background: p.brandBg || "#FBF8F2", fontFamily: mont, color: "#1A140F", ...frame(p) }}>
      <div style={{ flex: 1, padding: `${56 * u}px ${64 * u}px`, display: "flex", flexDirection: "column", gap: 32 * u }}>
        <div style={{ display: "flex", alignItems: "center", gap: 28 * u }}>
          <SafeImg src={p.faceImageUrl} style={{ width: 180 * u, height: 180 * u, borderRadius: 999, objectFit: "cover", border: `${5 * u}px solid #fff`, boxShadow: `0 ${8 * u}px ${24 * u}px rgba(0,0,0,0.18)`, flexShrink: 0 }} />
          <div>
            <Stars n={5} size={48 * u} />
            <div style={{ fontWeight: 800, fontSize: 40 * u, marginTop: 10 * u }}>{p.reviewerName}</div>
            {p.verified && <div style={{ marginTop: 6 * u }}><VerifiedTag s={28 * u} /></div>}
          </div>
        </div>
        {/* Growing, vertically-centered middle — fills the tall 9:16 frame. */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 32 * u, minHeight: 0 }}>
          <div style={{ fontWeight: 800, fontSize: quoteSize, lineHeight: 1.08, letterSpacing: -1 * u }}>
            <span style={{ color: accent }}>“</span>{p.quote}<span style={{ color: accent }}>”</span>
          </div>
          {p.body && <div style={{ fontWeight: 500, fontSize: 36 * u, lineHeight: 1.4, color: "#473C32" }}>{p.body}</div>}
          {portrait && p.productImageUrl && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 8 * u }}>
              <SafeImg src={p.productImageUrl} style={{ height: 360 * u, maxWidth: "70%", objectFit: "contain", filter: `drop-shadow(0 ${14 * u}px ${28 * u}px rgba(0,0,0,0.18))` }} />
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 * u }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 * u }}>
            <SafeImg src={p.productImageUrl} style={{ height: 130 * u, width: 130 * u, objectFit: "contain" }} />
            <div>
              <div style={{ fontWeight: 800, fontSize: 30 * u, color: accent, textTransform: "uppercase" }}>{p.productTitle}</div>
              <div style={{ fontWeight: 600, fontSize: 26 * u, color: "#6B5E52" }}>{p.reviewCount} five-star reviews</div>
            </div>
          </div>
          <span style={{ background: accent, color: "#fff", fontWeight: 800, fontSize: 34 * u, padding: `${18 * u}px ${36 * u}px`, borderRadius: 999, whiteSpace: "nowrap" }}>{p.cta}</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── 2. Authority (face) ───────────────────────────────────────────────────────
export interface StaticAuthorityProps extends Common { brandBg: string; expertName: string; expertTitle: string; quote: string; bullets: string[]; faceImageUrl?: string | null; productImageUrl?: string | null; productTitle: string; }
export const StaticAuthority: React.FC<StaticAuthorityProps> = (p) => {
  const u = p.width / 1080; const accent = p.accent || "#B0451C";
  return (
    <AbsoluteFill style={{ background: p.brandBg || "#FBF8F2", fontFamily: mont, color: "#1A140F", ...frame(p) }}>
      <div style={{ flex: 1, padding: `${56 * u}px ${64 * u}px`, display: "flex", flexDirection: "column", justifyContent: "center", gap: 34 * u }}>
        <div style={{ fontWeight: 800, fontSize: 30 * u, color: accent, letterSpacing: 2 * u, textTransform: "uppercase" }}>What the experts say</div>
        <div style={{ display: "flex", alignItems: "center", gap: 28 * u }}>
          <SafeImg src={p.faceImageUrl} style={{ width: 170 * u, height: 170 * u, borderRadius: 999, objectFit: "cover", border: `${5 * u}px solid #fff`, boxShadow: `0 ${8 * u}px ${24 * u}px rgba(0,0,0,0.18)`, flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 46 * u }}>{p.expertName}</div>
            <div style={{ fontWeight: 600, fontSize: 30 * u, color: "#6B5E52" }}>{p.expertTitle}</div>
          </div>
        </div>
        <div style={{ fontWeight: 700, fontSize: 58 * u, lineHeight: 1.2 }}>“{p.quote}”</div>
        <div style={{ display: "flex", alignItems: "center", gap: 40 * u }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 * u }}>
            {p.bullets.slice(0, 3).map((b, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 18 * u, fontWeight: 700, fontSize: 38 * u }}>
                <span style={{ width: 52 * u, height: 52 * u, borderRadius: 999, background: accent, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 30 * u, flexShrink: 0 }}>✓</span>
                {b}
              </div>
            ))}
          </div>
          {/* Product anchors the endorsement to the actual SKU. */}
          <SafeImg src={p.productImageUrl} style={{ width: 300 * u, height: 300 * u, objectFit: "contain", flexShrink: 0, filter: `drop-shadow(0 ${16 * u}px ${30 * u}px rgba(0,0,0,0.22))` }} />
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 * u }}>
          <TrustChips badges={p.badges} u={u} />
          <span style={{ background: accent, color: "#fff", fontWeight: 800, fontSize: 34 * u, padding: `${18 * u}px ${36 * u}px`, borderRadius: 999, whiteSpace: "nowrap" }}>{p.cta}</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── 3. Big-claim — contrarian / shock HOOK poster ─────────────────────────────
// Not a stat. A pattern-interrupt statement that attacks an assumption ("your
// coffee is aging you") to stop the thumb, then a turn line that reframes to the
// product. `emphasis` highlights one fragment of the hook in the accent color.
export interface StaticBigClaimProps extends Common { eyebrow?: string; hook: string; emphasis?: string; reveal: string; bg?: string; productImageUrl?: string | null; productTitle: string; }
export const StaticBigClaim: React.FC<StaticBigClaimProps> = (p) => {
  const u = p.width / 1080; const accent = p.accent || "#B0451C"; const bg = p.bg || "#15110D"; const hi = "#FFD23F";
  const renderHook = () => {
    if (!p.emphasis || !p.hook.includes(p.emphasis)) return p.hook;
    const [a, b] = p.hook.split(p.emphasis);
    return <>{a}<span style={{ color: hi }}>{p.emphasis}</span>{b}</>;
  };
  return (
    <AbsoluteFill style={{ background: bg, fontFamily: mont, color: "#fff", ...frame(p) }}>
      <div style={{ flex: 1, padding: `${64 * u}px ${64 * u}px`, display: "flex", flexDirection: "column" }}>
        {p.eyebrow && <div style={{ fontWeight: 800, fontSize: 30 * u, letterSpacing: 3 * u, textTransform: "uppercase", color: accent }}>{p.eyebrow}</div>}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 30 * u }}>
          <div style={{ fontWeight: 900, fontSize: 128 * u, lineHeight: 0.98, letterSpacing: -2 * u, textTransform: "uppercase" }}>{renderHook()}</div>
          <div style={{ fontWeight: 600, fontSize: 44 * u, lineHeight: 1.25, color: "rgba(255,255,255,0.88)", maxWidth: 880 * u }}>{p.reveal}</div>
          <SafeImg src={p.productImageUrl} style={{ height: 300 * u, width: 460 * u, objectFit: "contain", marginTop: 8 * u, filter: `drop-shadow(0 ${20 * u}px ${36 * u}px rgba(0,0,0,0.45))` }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 * u }}>
          <TrustChips badges={p.badges} u={u} dark />
          <span style={{ background: accent, color: "#fff", fontWeight: 800, fontSize: 36 * u, padding: `${18 * u}px ${40 * u}px`, borderRadius: 999, whiteSpace: "nowrap" }}>{p.cta}</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── 4. Before / After (problem → solution) ────────────────────────────────────
export interface StaticBeforeAfterProps extends Common { headline: string; beforeLabel: string; afterLabel: string; beforeText: string; afterText: string; beforeImageUrl?: string | null; afterImageUrl?: string | null; productTitle: string; }
export const StaticBeforeAfter: React.FC<StaticBeforeAfterProps> = (p) => {
  const u = p.width / 1080; const accent = p.accent || "#B0451C";
  const Panel: React.FC<{ label: string; text: string; img?: string | null; tone: "before" | "after" }> = ({ label, text, img, tone }) => (
    <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
      <SafeImg src={img} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: tone === "before" ? "grayscale(0.7) brightness(0.82)" : "none" }} />
      <AbsoluteFill style={{ background: tone === "before" ? "linear-gradient(180deg, rgba(20,16,12,0.35), rgba(20,16,12,0.55))" : `linear-gradient(180deg, rgba(176,69,28,0.15), rgba(176,69,28,0.45))` }} />
      <div style={{ position: "absolute", top: 28 * u, left: 28 * u, background: tone === "before" ? "#1A140F" : accent, color: "#fff", fontWeight: 800, fontSize: 30 * u, padding: `${8 * u}px ${20 * u}px`, borderRadius: 8 * u, textTransform: "uppercase", letterSpacing: 1 * u }}>{label}</div>
      <div style={{ position: "absolute", bottom: 28 * u, left: 28 * u, right: 28 * u, color: "#fff", fontWeight: 700, fontSize: 38 * u, lineHeight: 1.15, textShadow: "0 2px 8px rgba(0,0,0,0.6)" }}>{text}</div>
    </div>
  );
  return (
    <AbsoluteFill style={{ background: "#1A140F", fontFamily: mont, color: "#fff", ...frame(p) }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: `${36 * u}px ${48 * u}px`, textAlign: "center" }}>
          <div style={{ fontWeight: 900, fontSize: 64 * u, lineHeight: 1.05, textTransform: "uppercase", letterSpacing: -0.5 * u }}>{p.headline}</div>
        </div>
        <div style={{ flex: 1, display: "flex" }}>
          <Panel label={p.beforeLabel} text={p.beforeText} img={p.beforeImageUrl} tone="before" />
          <Panel label={p.afterLabel} text={p.afterText} img={p.afterImageUrl} tone="after" />
        </div>
        <div style={{ padding: `${30 * u}px ${48 * u}px`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 * u }}>
          <TrustChips badges={p.badges} u={u} dark />
          <span style={{ background: accent, color: "#fff", fontWeight: 800, fontSize: 36 * u, padding: `${18 * u}px ${40 * u}px`, borderRadius: 999, whiteSpace: "nowrap" }}>{p.cta}</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
