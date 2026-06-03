import React from "react";
import { AbsoluteFill, Sequence, OffthreadVideo, Img, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import type { AdCompositionProps, CaptionGroup, IngredientPop } from "./types";

/** Red translucent safe-zone overlay — only shown in studio/preview, never in renders. */
export const SafeZoneGuide: React.FC<{ core: AdCompositionProps["safeCore"] }> = ({ core }) => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    <div
      style={{
        position: "absolute",
        left: core.x,
        top: core.y,
        width: core.w,
        height: core.h,
        border: "3px solid rgba(255,0,0,0.5)",
        boxSizing: "border-box",
      }}
    />
  </AbsoluteFill>
);

/** Hormozi caption layer — 1-3 words, pop-in with overshoot, color flips, emphasis. */
export const CaptionLayer: React.FC<{ props: AdCompositionProps }> = ({ props }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const spec = props.captionSpec;
  const loud = props.vibeTags.includes("loud");
  const ugly = props.vibeTags.includes("ugly");
  const sizeBase = loud ? spec.loudSizePx : spec.baseSizePx;

  const active = props.captions.filter((c) => frame >= c.start * fps && frame <= c.end * fps + 6);
  return (
    <>
      {active.map((c, i) => (
        <CaptionWord key={i} c={c} frame={frame} fps={fps} spec={spec} sizeBase={sizeBase} ugly={ugly} core={props.safeCore} index={i} />
      ))}
    </>
  );
};

const CaptionWord: React.FC<{
  c: CaptionGroup;
  frame: number;
  fps: number;
  spec: AdCompositionProps["captionSpec"];
  sizeBase: number;
  ugly: boolean;
  core: AdCompositionProps["safeCore"];
  index: number;
}> = ({ c, frame, fps, spec, sizeBase, ugly, core, index }) => {
  const startFrame = c.start * fps;
  const popFrames = Math.max(1, Math.round((spec.popInMs / 1000) * fps));
  const s = spring({ frame: frame - startFrame, fps, config: { damping: 12, stiffness: 200 }, durationInFrames: popFrames * 2 });
  const scale = interpolate(s, [0, 1], [0.6, 1]) * (c.emphasis ? spec.emphasisScale : 1);
  const color = c.color === "yellow" ? spec.colorYellow : spec.colorWhite;
  const size = sizeBase * (c.emphasis ? spec.emphasisScale : 1);

  // ugly vibe: scatter into quadrants + slight rotation, still inside safe core.
  let left = core.x + core.w / 2;
  let top = core.y + core.h * spec.verticalPositionPct;
  let rotate = 0;
  let translate = "translate(-50%, -50%)";
  if (ugly) {
    const q = index % 4;
    left = core.x + core.w * (q % 2 === 0 ? 0.3 : 0.7);
    top = core.y + core.h * (q < 2 ? 0.45 : 0.65);
    rotate = (index % 2 === 0 ? 1 : -1) * 3;
  }

  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        transform: `${translate} scale(${scale}) rotate(${rotate}deg)`,
        fontFamily: spec.font,
        fontWeight: spec.fontWeight,
        fontSize: size,
        color,
        WebkitTextStroke: `${spec.strokePx}px ${spec.strokeColor}`,
        textShadow: `0 ${spec.shadowYpx}px 0 ${spec.shadow}`,
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        textAlign: "center",
      }}
    >
      {c.text}
    </div>
  );
};

/** Ingredient image pops, fired on Whisper word-timestamps. */
export const IngredientPopLayer: React.FC<{ pops: IngredientPop[]; fps: number; core: AdCompositionProps["safeCore"] }> = ({ pops, fps, core }) => {
  const frame = useCurrentFrame();
  const active = pops.filter((p) => frame >= p.start * fps && frame <= p.end * fps);
  return (
    <>
      {active.map((p, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            right: core.x + 20,
            top: core.y + 40,
            width: 240,
            height: 240,
            borderRadius: 16,
            overflow: "hidden",
            border: "6px solid #FFFF00",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}
        >
          <Img src={p.imageUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
      ))}
    </>
  );
};

/** Always-on credibility stack — pinned to the bottom of the safe core. */
export const CredibilityRow: React.FC<{ props: AdCompositionProps; ctaOnly?: boolean }> = ({ props, ctaOnly }) => {
  const cred = props.credibility;
  const core = props.safeCore;
  return (
    <div
      style={{
        position: "absolute",
        left: core.x,
        right: props.width - (core.x + core.w),
        bottom: props.height - (core.y + core.h) + 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: "center",
        fontFamily: "Inter, sans-serif",
      }}
    >
      {!ctaOnly && cred.badges.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
          {cred.badges.map((b, i) => (
            <span key={i} style={{ background: "#111", color: "#fff", padding: "6px 12px", borderRadius: 6, fontWeight: 700, fontSize: 26 }}>
              {b}
            </span>
          ))}
        </div>
      )}
      {!ctaOnly && cred.socialProof.length > 0 && (
        <div style={{ color: "#fff", fontWeight: 800, fontSize: 28, textAlign: "center", textShadow: "0 2px 6px rgba(0,0,0,0.7)" }}>
          {cred.socialProof.join(" · ")}
        </div>
      )}
      {cred.guarantee && (
        <div style={{ background: "#FFFF00", color: "#111", padding: "8px 16px", borderRadius: 8, fontWeight: 900, fontSize: 30 }}>{cred.guarantee}</div>
      )}
    </div>
  );
};

/** Sequence the talking-head + b-roll cuts per the cut plan. */
export const CutTrack: React.FC<{ props: AdCompositionProps }> = ({ props }) => {
  const { fps } = useVideoConfig();
  const th = props.talkingHeadSegments;
  const broll = props.brollClips;
  return (
    <>
      {props.cutPlan.map((seg, i) => {
        const from = Math.round(seg.startSec * fps);
        const dur = Math.max(1, Math.round((seg.endSec - seg.startSec) * fps));
        let src: string | null = null;
        if (seg.kind === "broll" || seg.kind === "cta") {
          const idx = seg.brollIndex ?? 0;
          src = broll[idx]?.video_url ?? broll[0]?.video_url ?? th[0] ?? null;
        } else {
          // talking head: alternate across available segments
          src = th[i % Math.max(1, th.length)] ?? th[0] ?? null;
        }
        if (!src) return null;
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            <OffthreadVideo src={src} muted={seg.kind !== "talking_head"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </Sequence>
        );
      })}
    </>
  );
};
