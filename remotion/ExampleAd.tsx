import React from "react";
import {
  AbsoluteFill,
  Sequence,
  OffthreadVideo,
  Audio,
  staticFile,
  useVideoConfig,
  useCurrentFrame,
  interpolate,
  spring,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Anton";

const { fontFamily } = loadFont();

// Segment/b-roll/music sources are either bundled static files (the local
// example) or remote signed URLs (production renders from the creative library).
const resolveSrc = (s: string): string => (/^https?:\/\//.test(s) ? s : staticFile(s));

export interface CaptionGroup {
  text: string;
  start: number; // global seconds
  end: number;
  color: "yellow" | "white";
  emphasis: boolean;
}

export interface ExampleAdProps {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  // base talking-head segments (their audio = the continuous VO spine)
  segments: { src: string; startSec: number; trimSec: number }[];
  // b-roll cutaways laid over the top (cover the visual; ASMR audio ducked low)
  broll: { src: string; fromSec: number; durSec: number; volume: number }[];
  // single low music bed under everything
  music: { src: string; volume: number } | null;
  // Hormozi caption beats (global timestamps)
  captions: CaptionGroup[];
}

/**
 * Canonical VO-spine ad composition (production + the local example use it):
 *   base talking segments (VO) + muted/ducked b-roll overlays + low music bed
 *   + word-synced Hormozi captions. 9:16; other formats reframe via objectFit
 *   cover. Driven by ad-render.ts (renderVoSpineVideo) from the creative library.
 */
export const ExampleAd: React.FC<ExampleAdProps> = (p) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Base layer: talking segments. Audio plays (the VO spine). Each segment
          is cut at its trim point so there's no dead air between them. */}
      {p.segments.map((s, i) => (
        <Sequence key={`seg${i}`} from={Math.round(s.startSec * fps)} durationInFrames={Math.round(s.trimSec * fps)}>
          <OffthreadVideo src={resolveSrc(s.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </Sequence>
      ))}

      {/* B-roll overlays: cover the visual for a beat; ASMR audio at low volume
          (the talking-head VO underneath keeps playing). */}
      {p.broll.map((b, i) => (
        <Sequence key={`broll${i}`} from={Math.round(b.fromSec * fps)} durationInFrames={Math.round(b.durSec * fps)}>
          <OffthreadVideo src={resolveSrc(b.src)} volume={b.volume} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </Sequence>
      ))}

      {/* Music bed — one track, low, under everything. */}
      {p.music && <Audio src={resolveSrc(p.music.src)} volume={p.music.volume} />}

      {/* Hormozi captions on top of everything. */}
      <Captions captions={p.captions} />
    </AbsoluteFill>
  );
};

// Keyword → emoji sticker. First match wins; pops in above the caption.
const EMOJI_MAP: [RegExp, string][] = [
  [/coffee/i, "☕"],
  [/pound|shed|weight|lost/i, "🔥"],
  [/aging|young|skin/i, "✨"],
  [/energy|energ/i, "⚡"],
  [/superfood|twelve|12/i, "🍄"],
  [/crash|jitter/i, "🚫"],
  [/cravin|appetite|hunger/i, "🙅"],
  [/free|shipping/i, "📦"],
  [/off|forty|40|percent|%|deal|save/i, "🏷️"],
  [/limited|time|now|today|hurry/i, "⏰"],
  [/website|visit|click|link/i, "👉"],
  [/dietitian|recommend|doctor|expert/i, "✅"],
  [/wrong|bad|stop/i, "❌"],
];
function emojiFor(text: string): string | null {
  for (const [re, e] of EMOJI_MAP) if (re.test(text)) return e;
  return null;
}

const Captions: React.FC<{ captions: CaptionGroup[] }> = ({ captions }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  // Exactly ONE caption on screen at a time — each caption's `end` is the next
  // caption's start (set in the render script), so they never overlap or gap.
  const active = captions.filter((c) => frame >= c.start * fps && frame < c.end * fps);
  return (
    <>
      {active.map((c, i) => {
        const startF = c.start * fps;
        const s = spring({ frame: frame - startF, fps, config: { damping: 12, stiffness: 220 }, durationInFrames: 9 });
        const scale = interpolate(s, [0, 1], [0.62, 1]) * (c.emphasis ? 1.18 : 1);
        const color = c.color === "yellow" ? "#FFFF00" : "#FFFFFF";
        const size = width * 0.092 * (c.emphasis ? 1.22 : 1);
        const emoji = emojiFor(c.text);
        // Emoji bounce-in, slightly delayed + a playful tilt.
        const es = spring({ frame: frame - startF - 2, fps, config: { damping: 9, stiffness: 180 }, durationInFrames: 12 });
        const eScale = interpolate(es, [0, 1], [0, 1]);
        const tilt = (i % 2 === 0 ? 1 : -1) * 8;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: "50%",
              top: "57%",
              transform: `translate(-50%, -50%) scale(${scale})`,
              textAlign: "center",
              whiteSpace: "nowrap",
            }}
          >
            {emoji && (
              <div
                style={{
                  fontSize: size * 0.95,
                  lineHeight: 1,
                  marginBottom: size * 0.12,
                  transform: `scale(${eScale}) rotate(${tilt}deg)`,
                  filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.5))",
                }}
              >
                {emoji}
              </div>
            )}
            <div
              style={{
                fontFamily,
                fontWeight: 400,
                fontSize: size,
                color,
                WebkitTextStroke: `${Math.round(width * 0.006)}px #000000`,
                paintOrder: "stroke fill",
                textShadow: "0 6px 0 rgba(0,0,0,0.55)",
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              {c.text}
            </div>
          </div>
        );
      })}
    </>
  );
};
