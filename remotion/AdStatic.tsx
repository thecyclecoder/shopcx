import React from "react";
import { AbsoluteFill, Img } from "remotion";
import type { AdCompositionProps } from "./types";
import { CredibilityRow } from "./components";

/**
 * Static-ad composition (one still per format). V1 ships the
 * "shipping_label_brutalist" template by default: solid oversaturated bg, hero
 * offset bottom-right, hook headline in Anton Black at the top inside the safe
 * core, proof anchor in a yellow-highlighter block, credibility row at the
 * bottom safe edge. The other templates (scanned_receipt, headline_newspaper,
 * comparison_meme, ingredient_stack) are selected via props.staticTemplate.
 *
 * All readable text lives inside props.safeCore — the renderer asserts this.
 */
const BG_BY_VIBE: Record<string, string> = {
  loud: "#FF2D55",
  ugly: "#FF6A00",
  clinical: "#0A84FF",
  weird: "#00E0A4",
  default: "#FF8A00",
};

export const AdStatic: React.FC<AdCompositionProps> = (props) => {
  const core = props.safeCore;
  const vibe = props.vibeTags.find((v) => BG_BY_VIBE[v]) || "default";
  const bg = BG_BY_VIBE[vibe] || BG_BY_VIBE.default;
  const headline = (props.staticHeadline || props.credibility.guarantee || "").toUpperCase();
  const proof = props.credibility.socialProof[0] || "";

  return (
    <AbsoluteFill style={{ backgroundColor: bg }}>
      {/* Hero — can bleed off the edge; not safe-zone-constrained. */}
      {props.heroImageUrl && (
        <Img
          src={props.heroImageUrl}
          style={{ position: "absolute", right: -40, bottom: props.height * 0.18, width: props.width * 0.72, objectFit: "contain" }}
        />
      )}

      {/* Headline — top of the safe core. */}
      <div
        style={{
          position: "absolute",
          left: core.x,
          top: core.y,
          width: core.w,
          fontFamily: "Anton, Inter, sans-serif",
          fontWeight: 900,
          fontSize: 110,
          lineHeight: 1.0,
          color: "#fff",
          textTransform: "uppercase",
          WebkitTextStroke: "3px #111",
        }}
      >
        {headline}
      </div>

      {/* Proof anchor — yellow highlighter block under the headline. */}
      {proof && (
        <div
          style={{
            position: "absolute",
            left: core.x,
            top: core.y + 340,
            background: "#FFFF00",
            color: "#111",
            padding: "10px 18px",
            fontFamily: "Inter, sans-serif",
            fontWeight: 800,
            fontSize: 40,
            transform: "rotate(-2deg)",
          }}
        >
          {proof}
        </div>
      )}

      <CredibilityRow props={props} />
    </AbsoluteFill>
  );
};
