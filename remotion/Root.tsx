import React from "react";
import { Composition } from "remotion";
import { AdComposition } from "./AdComposition";
import { AdStatic } from "./AdStatic";
import { DEFAULT_PROPS, type AdCompositionProps } from "./types";

/**
 * Two compositions: AdComposition (video MP4) and AdStatic (still JPG). The
 * renderer in ad-render.ts selects one by id and passes inputProps. width/height/
 * fps/durationInFrames are calculated per-render from the inputProps.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="AdComposition"
        component={AdComposition as React.FC<Record<string, unknown>>}
        durationInFrames={DEFAULT_PROPS.durationSec * DEFAULT_PROPS.fps}
        fps={DEFAULT_PROPS.fps}
        width={DEFAULT_PROPS.width}
        height={DEFAULT_PROPS.height}
        defaultProps={DEFAULT_PROPS as unknown as Record<string, unknown>}
        calculateMetadata={({ props }) => {
          const p = props as unknown as AdCompositionProps;
          return { durationInFrames: Math.round(p.durationSec * p.fps), fps: p.fps, width: p.width, height: p.height };
        }}
      />
      <Composition
        id="AdStatic"
        component={AdStatic as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={1}
        width={DEFAULT_PROPS.width}
        height={DEFAULT_PROPS.height}
        defaultProps={{ ...DEFAULT_PROPS, mediaKind: "static" } as unknown as Record<string, unknown>}
        calculateMetadata={({ props }) => {
          const p = props as unknown as AdCompositionProps;
          return { durationInFrames: 1, fps: 1, width: p.width, height: p.height };
        }}
      />
    </>
  );
};
