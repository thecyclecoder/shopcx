// Mirror of AdCompositionProps from src/lib/ad-render.ts. Kept local so /remotion
// stays self-contained (it's excluded from the app tsconfig). If you change the
// shape in ad-render.ts, mirror it here.

export interface CaptionGroup {
  text: string;
  start: number;
  end: number;
  color: "yellow" | "white";
  emphasis: boolean;
}

export interface CutSegment {
  kind: "talking_head" | "broll" | "cta";
  startSec: number;
  endSec: number;
  brollIndex?: number;
}

export interface CredibilityRow {
  badges: string[];
  socialProof: string[];
  guarantee: string;
}

export interface IngredientPop {
  ingredient: string;
  imageUrl: string;
  start: number;
  end: number;
}

export interface AdCompositionProps {
  format: string;
  mediaKind: "video" | "static";
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  style: "hormozi_yellow" | "hormozi_white" | "clean_white";
  vibeTags: string[];
  talkingHeadSegments: string[];
  brollClips: Array<{ video_url: string; motion_id: string }>;
  captions: CaptionGroup[];
  cutPlan: CutSegment[];
  credibility: CredibilityRow;
  ingredientPops: IngredientPop[];
  safeCore: { x: number; y: number; w: number; h: number };
  heroImageUrl?: string;
  staticHeadline?: string;
  staticTemplate?: string;
  captionSpec: {
    font: string;
    fontWeight: number;
    baseSizePx: number;
    loudSizePx: number;
    emphasisScale: number;
    colorYellow: string;
    colorWhite: string;
    strokeColor: string;
    strokePx: number;
    shadow: string;
    shadowYpx: number;
    popInMs: number;
    overshoot: number;
    verticalPositionPct: number;
  };
}

export const DEFAULT_PROPS: AdCompositionProps = {
  format: "reels_9x16",
  mediaKind: "video",
  width: 1080,
  height: 1920,
  fps: 30,
  durationSec: 15,
  style: "hormozi_yellow",
  vibeTags: [],
  talkingHeadSegments: [],
  brollClips: [],
  captions: [],
  cutPlan: [],
  credibility: { badges: [], socialProof: [], guarantee: "" },
  ingredientPops: [],
  safeCore: { x: 65, y: 269, w: 950, h: 1010 },
  captionSpec: {
    font: "Anton",
    fontWeight: 700,
    baseSizePx: 96,
    loudSizePx: 110,
    emphasisScale: 1.3,
    colorYellow: "#FFFF00",
    colorWhite: "#FFFFFF",
    strokeColor: "#000000",
    strokePx: 8,
    shadow: "rgba(0,0,0,0.6)",
    shadowYpx: 4,
    popInMs: 80,
    overshoot: 1.05,
    verticalPositionPct: 0.6,
  },
};
