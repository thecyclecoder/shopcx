import React from "react";
import { AbsoluteFill, useVideoConfig, useCurrentFrame } from "remotion";
import type { AdCompositionProps } from "./types";
import { CutTrack, CaptionLayer, IngredientPopLayer, CredibilityRow } from "./components";

/**
 * The video ad composition. Layers, bottom to top:
 *   1. Cut track (talking-head + b-roll, sequenced per cutPlan)
 *   2. Ingredient image pops (word-timestamp triggered)
 *   3. Hormozi captions
 *   4. Credibility row (CTA-only in the last 1.5s)
 *
 * Safe-zone correctness is enforced upstream in ad-render.ts (validateSafeZone)
 * before encode; here every text/badge layer is positioned WITHIN props.safeCore.
 */
export const AdComposition: React.FC<AdCompositionProps> = (props) => {
  const { durationInFrames, fps } = useVideoConfig();
  const ctaStartFrame = durationInFrames - Math.round(1.5 * fps);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <CutTrack props={props} />
      <IngredientPopLayer pops={props.ingredientPops} fps={fps} core={props.safeCore} />
      <CaptionLayer props={props} />
      {/* Full credibility stack for most of the ad; CTA-only guarantee in the last 1.5s. */}
      <FrameGated until={ctaStartFrame}>
        <CredibilityRow props={props} />
      </FrameGated>
      <FrameGated from={ctaStartFrame}>
        <CredibilityRow props={props} ctaOnly />
      </FrameGated>
    </AbsoluteFill>
  );
};

const FrameGated: React.FC<{ from?: number; until?: number; children: React.ReactNode }> = ({ from, until, children }) => {
  const frame = useCurrentFrame();
  if (from !== undefined && frame < from) return null;
  if (until !== undefined && frame >= until) return null;
  return <>{children}</>;
};
