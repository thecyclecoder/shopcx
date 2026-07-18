/**
 * Ad tool — single source of truth for the direct-response frameworks the
 * generator, validator, and renderer all share. Keeping these here (not
 * scattered across prompts/components) means the hook list, LF8 framework,
 * format matrix, and safe-zone numbers can't drift between subsystems.
 *
 * See docs/brain/specs/ad-tool.md for the rationale behind each constant.
 */

// ── Life Force 8 (Cashvertising, Whitman) ──────────────────────────────────
export const LIFE_FORCE_8: Record<number, string> = {
  1: "Survival, enjoyment of life, life extension",
  2: "Enjoyment of food and beverages",
  3: "Freedom from fear, pain, and danger",
  4: "Sexual companionship",
  5: "Comfortable living conditions",
  6: "To be superior, winning, keeping up with the Joneses",
  7: "Care and protection of loved ones",
  8: "Social approval",
};

// ── The 12 hook formulas ───────────────────────────────────────────────────
export interface HookFormula {
  slug: string;
  template: string;
  lever: string;
  bestForLf8: number[];
  spokenHook: boolean; // false = open on a visual, no spoken hook line
}

export const HOOK_FORMULAS: HookFormula[] = [
  { slug: "problem_now", template: "If you wake up and [pain] before [time]…", lever: "Immediate self-recognition", bestForLf8: [3], spokenHook: true },
  { slug: "contrarian", template: "You've been [common habit] completely wrong.", lever: "Pattern break + curiosity", bestForLf8: [1, 5], spokenHook: true },
  { slug: "results_first", template: "I [outcome] in [unrealistic short time] doing this.", lever: "Anchors on proof before explanation", bestForLf8: [1, 6], spokenHook: true },
  { slug: "callout", template: "If you're a [demographic] over [age], stop scrolling.", lever: "Self-targeting via identity", bestForLf8: [6, 8], spokenHook: true },
  { slug: "enemy", template: "The [industry] doesn't want you to know this.", lever: "Establishes shared enemy", bestForLf8: [6, 7], spokenHook: true },
  { slug: "secret_reveal", template: "Nobody talks about why [problem]. Here's the truth.", lever: "Curiosity gap", bestForLf8: [1, 3], spokenHook: true },
  { slug: "urgent_question", template: "Do you [behavior]? Then this is killing you.", lever: "Implicit threat", bestForLf8: [1, 3], spokenHook: true },
  { slug: "social_proof_shock", template: "300 [demographic] just bought this in the last hour.", lever: "FOMO + bandwagon", bestForLf8: [6, 8], spokenHook: true },
  { slug: "visual_shock", template: "(no spoken hook — open on weird/satisfying/jarring visual)", lever: "Stops scroll pre-cognition", bestForLf8: [1, 2, 3, 4, 5, 6, 7, 8], spokenHook: false },
  { slug: "story_in_progress", template: "So I'm at [unexpected place] and this happens…", lever: "Native, story-driven curiosity", bestForLf8: [8], spokenHook: true },
  { slug: "keeping_up", template: "Everyone you know is [doing X] except you.", lever: "LF8 #6 directly", bestForLf8: [6], spokenHook: true },
  { slug: "loved_one_at_risk", template: "Your [child/spouse/parent] is [doing X] and you have no idea.", lever: "LF8 #7", bestForLf8: [7], spokenHook: true },
];

export const HOOK_SLUGS = HOOK_FORMULAS.map((h) => h.slug);

// ── Urgency levers + vibe tags ─────────────────────────────────────────────
export const URGENCY_LEVERS = ["limited_batch", "selling_out", "price_increase_soon", "seasonal", "none"] as const;
export type UrgencyLever = (typeof URGENCY_LEVERS)[number];

export const VIBE_TAGS = ["ugly", "loud", "weird", "phone_recorded", "clinical"] as const;
export type VibeTag = (typeof VIBE_TAGS)[number];

// ── Scene styles (setting + action) ─────────────────────────────────────────
// Every ad used to be the identical shot — person holding the product, facing
// camera, outdoors. That sameness kills the scroll-stopping variety paid social
// needs. A scene style swaps two things:
//   - `hero`   → the ENVIRONMENT clause in the holding-product image prompt
//                (buildHoldingProductPrompt). "holding the product at chest
//                height, looking at camera" stays constant (the Seedream combine
//                needs it); only the setting/pose around it changes.
//   - `motion` → the ACTION + camera clause in the Veo talking-head prompt
//                (buildTalkingHeadPrompt). The talking-head animates the hero
//                still, so the motion must be consistent with the hero setting.
// Per-campaign: `ad_campaigns.scene_style`. Pick different styles across
// campaigns to make a varied ad library from one product/avatar.
export interface AdSceneStyle {
  value: string;
  label: string;
  description: string; // operator-facing helper text
  hero: string; // environment/pose clause for the hero image
  motion: string; // action/camera clause for the Veo talking-head clip
}

export const AD_SCENE_STYLES: readonly AdSceneStyle[] = [
  {
    value: "outdoor_selfie",
    label: "Outdoor selfie",
    description: "The classic — facing camera outdoors in natural daylight. The original look.",
    hero: "outdoors in bright natural daylight",
    motion: "Authentic handheld selfie video outdoors, natural daylight, subtle real movement, relaxed unhurried pace",
  },
  {
    value: "kitchen_counter",
    label: "Kitchen counter",
    description: "At home in a bright kitchen, product on the countertop — morning-routine feel.",
    hero: "standing at the counter of a bright, lived-in home kitchen with soft morning light from a window, the product also visible resting on the countertop",
    motion: "Filmed in a home kitchen with the phone propped up or handheld, the person leans against the counter and occasionally picks up the product, relaxed and conversational morning-routine energy",
  },
  {
    value: "walk_and_talk",
    label: "Walk & talk",
    description: "Walking toward the camera while talking — high-energy, native to Reels.",
    hero: "walking along a sunny, tree-lined sidewalk, caught candidly mid-stride",
    motion: "Handheld selfie video where the person walks slowly toward the camera while talking, so the frame bobs gently with each step, candid outdoor energy",
  },
  {
    value: "living_room_couch",
    label: "Cozy couch",
    description: "Relaxed on the couch at home — warm, intimate, confiding-to-a-friend tone.",
    hero: "sitting back on a comfortable couch in a cozy, warmly lit living room",
    motion: "Relaxed handheld selfie on the couch, the person sits back comfortably, warm and intimate living-room energy",
  },
  {
    value: "car_front_seat",
    label: "Car selfie",
    description: "Talking from the parked car — the most native, unpolished UGC format.",
    hero: "sitting in the driver's seat of a parked car with daylight coming through the windshield",
    motion: "Candid car selfie filmed on a phone propped on the dash or handheld, very native unpolished UGC feel, natural daylight through the windshield",
  },
  {
    value: "home_desk",
    label: "Desk / WFH",
    description: "At a home-office desk, product beside the laptop — for the busy-professional buyer.",
    hero: "sitting at a tidy home-office desk with a laptop and the product on the desk beside the keyboard, soft natural daylight",
    motion: "Filmed at a desk with the phone propped up, the person takes a short break from work to talk to camera, casual and conversational",
  },
] as const;

export const DEFAULT_SCENE_STYLE = "outdoor_selfie";

/** Resolve a scene-style value to its definition (falls back to the default). */
export function getSceneStyle(value: string | null | undefined): AdSceneStyle {
  return AD_SCENE_STYLES.find((s) => s.value === value) || AD_SCENE_STYLES[0];
}

// ── Avatar b-roll actions (animate the avatar, not stock product b-roll) ─────
// Instead of reusing a product still, generate a NEW b-roll clip of the ad's own
// avatar doing something — making coffee, sipping, opening the bag, holding a raw
// ingredient, checking looser clothes in the mirror. Two-step generation (see
// adToolBrollRequested mode="avatar"):
//   1. STILL — Nano Banana combine of [avatar face] (+ product bag when
//      `usesProduct`) with `still` → a photoreal frame of her mid-action, identity
//      locked to her face.
//   2. MOTION — Veo image-to-video animates that still with `motion`.
// `{product}` in a prompt is replaced with the product title at generation time.
// No real ingredient photos exist, so chaga/cordyceps are model-imagined in her
// hand (identity still comes from her face).
export interface AvatarBrollAction {
  value: string;
  label: string;
  usesProduct: boolean; // combine with the product bag image (vs avatar face alone)
  still: string; // prompt for the action frame (Nano Banana combine)
  motion: string; // prompt to animate the frame (Veo)
}

export const AVATAR_BROLL_ACTIONS: readonly AvatarBrollAction[] = [
  {
    value: "making_instant_coffee",
    label: "Making an instant coffee",
    usesProduct: true,
    still: "in a bright home kitchen, spooning instant coffee from the {product} pouch (SECOND image) into a mug of hot water on the counter, mid-action and looking down at the mug",
    motion: "She stirs the instant coffee into the mug of hot water with a spoon, soft steam rising, relaxed handheld kitchen b-roll",
  },
  {
    value: "sipping_coffee",
    label: "Sipping a coffee",
    usesProduct: false,
    still: "holding a warm mug of coffee with both hands close to her face, eyes relaxed, about to take a sip, cozy warm light",
    motion: "She lifts the mug and takes a slow, satisfied sip of coffee, faint steam, warm natural light, gentle handheld",
  },
  {
    value: "opening_bag",
    label: "Opening the bag of product",
    usesProduct: true,
    still: "holding the {product} pouch (SECOND image) in both hands and peeling open its resealable top, looking down into the bag",
    motion: "She peels open the resealable pouch and glances inside with a pleased expression, natural handheld close-up",
  },
  {
    value: "holding_chaga",
    label: "Holding chaga in her hand",
    usesProduct: false,
    still: "holding a raw chunk of dark chaga mushroom in her open palm, presenting it toward the camera, soft natural light",
    motion: "She holds out the raw chunk of chaga mushroom in her open palm and turns it slightly toward the camera, soft daylight",
  },
  {
    value: "holding_cordyceps",
    label: "Holding cordyceps in her hand",
    usesProduct: false,
    still: "holding a small pile of golden dried cordyceps in her open palm, presenting it toward the camera, soft natural light",
    motion: "She holds out the dried cordyceps in her open palm and turns her hand slightly toward the camera, soft daylight",
  },
  {
    value: "mirror_looser_clothes",
    label: "Mirror — looser clothes (weight loss)",
    usesProduct: false,
    still: "standing at a bedroom mirror, smiling, pulling the waistband of her now-too-loose jeans away from her waist to show how much room there is, happy and surprised",
    motion: "At the mirror she tugs the waistband of her loose jeans out to show the extra room, happy and a little surprised, natural light",
  },
] as const;

export function getAvatarBrollAction(value: string | null | undefined): AvatarBrollAction | null {
  return AVATAR_BROLL_ACTIONS.find((a) => a.value === value) || null;
}

// ── Banned soft words (default; workspace-configurable) ─────────────────────
export const DEFAULT_BANNED_WORDS = [
  "supports", "promotes", "helps", "may aid", "natural", "wellness", "boost", "enhance",
];

// Opener patterns that read as "warm intro" — instant reject.
export const BANNED_OPENERS = ["hey", "hi", "hello", "welcome", "introducing"];

// Soft CTAs — must be imperative + urgency instead.
export const SOFT_CTA_PHRASES = ["learn more", "click to discover", "find out more", "check it out", "see more"];

// ── Caption style spec (Hormozi) ───────────────────────────────────────────
export const CAPTION_STYLES = ["hormozi_yellow", "hormozi_white", "clean_white"] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];

export const CAPTION_SPEC = {
  font: "Anton",
  fontWeight: 700,
  baseSizePx: 96, // on a 1080-wide canvas
  loudSizePx: 110,
  emphasisScale: 1.3, // ALL-CAPS words
  colorYellow: "#FFFF00",
  colorWhite: "#FFFFFF",
  strokeColor: "#000000",
  strokePx: 8,
  shadow: "rgba(0,0,0,0.6)",
  shadowYpx: 4,
  popInMs: 80,
  overshoot: 1.05,
  verticalPositionPct: 0.6, // 60% down the frame
} as const;

// ── Format matrix + Meta safe zones ────────────────────────────────────────
export type AdFormat = "reels_9x16" | "feed_4x5" | "stories_9x16";
export type MediaKind = "video" | "static";

export interface SafeZone {
  // fraction of canvas reserved at each edge; the safe core is what's left
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface FormatSpec {
  format: AdFormat;
  aspect: string;
  width: number;
  height: number;
  videoSafeZone: SafeZone; // used for the video render
  staticSafeZone: SafeZone; // statics get a less aggressive bottom zone
  placements: string[];
}

export const FORMAT_SPECS: Record<AdFormat, FormatSpec> = {
  reels_9x16: {
    format: "reels_9x16",
    aspect: "9:16",
    width: 1080,
    height: 1920,
    // Reels UI is the most aggressive: 14% top / 35% bottom / 6% sides.
    videoSafeZone: { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 },
    staticSafeZone: { top: 0.14, bottom: 0.2, left: 0.06, right: 0.06 },
    placements: ["Instagram Reels", "TikTok", "Facebook Reels"],
  },
  feed_4x5: {
    format: "feed_4x5",
    aspect: "4:5",
    width: 1080,
    height: 1350,
    videoSafeZone: { top: 0.14, bottom: 0.14, left: 0.14, right: 0.14 },
    staticSafeZone: { top: 0.14, bottom: 0.14, left: 0.14, right: 0.14 },
    placements: ["Instagram feed", "Facebook feed"],
  },
  stories_9x16: {
    format: "stories_9x16",
    aspect: "9:16",
    width: 1080,
    height: 1920,
    videoSafeZone: { top: 0.14, bottom: 0.2, left: 0.06, right: 0.06 },
    staticSafeZone: { top: 0.14, bottom: 0.2, left: 0.06, right: 0.06 },
    placements: ["Instagram Stories", "Facebook Stories"],
  },
};

// The four outputs every ad produces.
export const VIDEO_FORMATS: AdFormat[] = ["reels_9x16", "feed_4x5"];
export const STATIC_FORMATS: AdFormat[] = ["stories_9x16", "feed_4x5"];

/** Compute the safe-core rectangle in px for a format + media kind. */
export function safeCore(format: AdFormat, kind: MediaKind): { x: number; y: number; w: number; h: number } {
  const f = FORMAT_SPECS[format];
  const z = kind === "video" ? f.videoSafeZone : f.staticSafeZone;
  const x = Math.round(f.width * z.left);
  const y = Math.round(f.height * z.top);
  const w = Math.round(f.width * (1 - z.left - z.right));
  const h = Math.round(f.height * (1 - z.top - z.bottom));
  return { x, y, w, h };
}

// ── Static-ad templates ────────────────────────────────────────────────────
export const STATIC_TEMPLATES = [
  "shipping_label_brutalist",
  "scanned_receipt",
  "headline_newspaper",
  "comparison_meme",
  "ingredient_stack",
] as const;
export type StaticTemplate = (typeof STATIC_TEMPLATES)[number];

// ── DoP b-roll motion presets, biased toward jarring choices per vibe ───────
export const MOTION_PRESETS = {
  jarring: ["parallax_zoom", "snap_zoom", "dolly_in"],
  calm: ["pan_left", "pan_right", "slow_zoom"],
} as const;

/** Eligible motion ids for a set of vibe tags (jarring unless purely clinical). */
export function eligibleMotions(vibeTags: string[]): string[] {
  const jarring = vibeTags.some((v) => v === "ugly" || v === "loud" || v === "weird");
  return jarring ? [...MOTION_PRESETS.jarring] : [...MOTION_PRESETS.jarring, ...MOTION_PRESETS.calm];
}

// ── Hard caps ──────────────────────────────────────────────────────────────
// Meta's field limits are much higher (headline 255 · primary ~2200 · description 255); these are our
// working targets. `headline: 40` keeps the bold headline from truncating in-feed. `primary_text` was
// 125 (the "…See more" fold length) used as a HARD cap — that forced terse, story-less captions like
// "I lost 40+ pounds! Appetite suppression/craving control" (2026-07-13). Raised to 600 so a real DR
// caption (proof-led opener → benefits → trust → offer + CTA) fits; the fold is a display detail, not a
// reason to gut the copy. `description` raised 30 → 90 so the offer/value line isn't clipped mid-phrase.
export const META_CAPS = { headline: 40, primary_text: 600, description: 90 } as const;
export const MAX_SPOKEN_SECONDS = 30;
export const MAX_AVATARS_PER_WORKSPACE = 10;
export const DEFAULT_COST_CAP_CENTS = 1000; // $10/ad

// ── Per-workspace settings shape (workspaces.ad_tool_settings) ──────────────
export interface AdToolSettings {
  banned_words: string[];
  lf8_allowed: number[]; // which LF8 slots the brand may target
  ugly_intensity: "mild" | "heavy" | "extreme";
  default_caption_style: CaptionStyle;
  default_urgency_by_category: Record<string, UrgencyLever>;
  pinned_badges: string[]; // ordered credibility chips
  cost_cap_cents: number;
}

export const DEFAULT_AD_TOOL_SETTINGS: AdToolSettings = {
  banned_words: DEFAULT_BANNED_WORDS,
  lf8_allowed: [1, 2, 3, 5, 6, 7, 8], // #4 (sexual companionship) off by default
  ugly_intensity: "heavy",
  default_caption_style: "hormozi_yellow",
  default_urgency_by_category: {},
  pinned_badges: ["Made In The USA", "Non-GMO", "3rd Party Tested"],
  cost_cap_cents: DEFAULT_COST_CAP_CENTS,
};

/** Merge stored partial settings over the defaults. */
export function resolveAdToolSettings(stored: unknown): AdToolSettings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Partial<AdToolSettings>;
  return {
    ...DEFAULT_AD_TOOL_SETTINGS,
    ...s,
    banned_words: Array.isArray(s.banned_words) && s.banned_words.length ? s.banned_words : DEFAULT_AD_TOOL_SETTINGS.banned_words,
    lf8_allowed: Array.isArray(s.lf8_allowed) && s.lf8_allowed.length ? s.lf8_allowed : DEFAULT_AD_TOOL_SETTINGS.lf8_allowed,
    pinned_badges: Array.isArray(s.pinned_badges) ? s.pinned_badges : DEFAULT_AD_TOOL_SETTINGS.pinned_badges,
    default_urgency_by_category: s.default_urgency_by_category || {},
  };
}

export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// ── Avatar generation attributes (text-to-image, no reference photos) ────────
// The four controls that drive Soul face generation. Gender + age pre-fill from
// the buyer demographic cohort; health level + ethnicity are operator choices.
export const AVATAR_GENDERS = ["female", "male"] as const;
export type AvatarGender = (typeof AVATAR_GENDERS)[number];

// Mirrors customer_demographics.inferred_age_range bands.
export const AVATAR_AGE_RANGES = ["under_25", "25-34", "35-44", "45-54", "55-64", "65+"] as const;
export type AvatarAgeRange = (typeof AVATAR_AGE_RANGES)[number];

export const AVATAR_HEALTH_LEVELS = [
  { value: "athletic", label: "Super healthy / athletic", prompt: "lean and athletic, visibly very fit, glowing healthy skin, toned" },
  { value: "fit", label: "Fit / healthy", prompt: "fit and healthy-looking, energetic, clear skin" },
  { value: "average", label: "Average", prompt: "average everyday build, normal healthy appearance" },
  { value: "relatable", label: "Everyday / relatable", prompt: "ordinary relatable build, soft, approachable everyday person" },
] as const;
export type AvatarHealthLevel = (typeof AVATAR_HEALTH_LEVELS)[number]["value"];

// "auto" lets the image model choose; the rest are explicit. Operator-picked
// (we have no ethnicity data to infer from).
export const AVATAR_ETHNICITIES = [
  { value: "auto", label: "Auto / no preference", prompt: "" },
  { value: "white", label: "White", prompt: "White / Caucasian" },
  { value: "black", label: "Black / African American", prompt: "Black / African American" },
  { value: "hispanic", label: "Hispanic / Latino", prompt: "Hispanic / Latino" },
  { value: "east_asian", label: "East Asian", prompt: "East Asian" },
  { value: "south_asian", label: "South Asian", prompt: "South Asian" },
  { value: "southeast_asian", label: "Southeast Asian", prompt: "Southeast Asian" },
  { value: "middle_eastern", label: "Middle Eastern / North African", prompt: "Middle Eastern / North African" },
  { value: "native_american", label: "Native American", prompt: "Native American / Indigenous" },
  { value: "pacific_islander", label: "Pacific Islander", prompt: "Pacific Islander" },
  { value: "mixed", label: "Mixed / Multiracial", prompt: "mixed / multiracial" },
] as const;
export type AvatarEthnicity = (typeof AVATAR_ETHNICITIES)[number]["value"];

const AGE_TO_APPARENT: Record<string, string> = {
  under_25: "early 20s",
  "25-34": "late 20s to early 30s",
  "35-44": "late 30s to early 40s",
  "45-54": "late 40s to early 50s",
  "55-64": "late 50s to early 60s",
  "65+": "mid-to-late 60s",
};

export interface AvatarFaceAttributes {
  gender: AvatarGender;
  ageRange: string;
  healthLevel: AvatarHealthLevel;
  ethnicity: AvatarEthnicity;
}

/** Build a Soul text-to-image portrait prompt from the four attributes (+ optional context). */
export function buildAvatarPortraitPrompt(attrs: AvatarFaceAttributes, context: string, angleVariant: number): string {
  const health = AVATAR_HEALTH_LEVELS.find((h) => h.value === attrs.healthLevel)?.prompt || "healthy-looking";
  const eth = AVATAR_ETHNICITIES.find((e) => e.value === attrs.ethnicity)?.prompt || "";
  const apparentAge = AGE_TO_APPARENT[attrs.ageRange] || attrs.ageRange;
  const ethClause = eth ? `${eth} ` : "";
  const angles = [
    "upper-body shot, looking directly at the camera",
    "slightly off-center selfie angle, mid-sentence candid expression",
    "three-quarter angle, warm natural smile",
  ];
  const ctx = context ? ` ${context}.` : "";
  return `Photorealistic UGC-style portrait photo of a real ${ethClause}${attrs.gender}, apparent age ${apparentAge}, ${health}.${ctx} ${angles[angleVariant % angles.length]}, natural daylight, authentic non-stock expression, shot on a phone. No text, no watermark, no product in frame.`;
}

// ── Physical size cue (hero holding-product true-to-life scaling) ───────────
/**
 * Loose shape matching the `physical_dimensions` jsonb stored on
 * `products` / `product_variants` (see `docs/brain/lifecycles/ad-render.md`
 * Phase 0). Everything is optional so a null/partial row degrades safely.
 */
export interface PhysicalDimensionsLite {
  length_in?: number | null;
  width_in?: number | null;
  height_in?: number | null;
  weight_oz?: number | null;
  shape?: string | null;
}

/**
 * Derive an explicit real-world size cue for the hero holding-product
 * composition. The Nano Banana Pro combine ignores the product's true
 * dimensions and shrinks a 6"×5" box to a drink-can — so we inject an
 * unambiguous "render it at N inch by M inch scale in the hand" clause
 * derived from the two front-facing dimensions.
 *
 * The two visible-face dimensions are the LARGEST two of length/width/height
 * (a box lying flat in the hand shows length × width; a bag or bottle
 * shows height × width). Picking the two largest keeps the cue stable
 * regardless of which axis the operator called "height" when entering dims.
 *
 * Returns an empty string for any missing / non-positive core dimension so
 * `buildHoldingProductPrompt` can safely concatenate `${cue}` without a crash
 * or a broken sentence. The caller — not this helper — decides whether to
 * surface "product needs dimensions" to the operator.
 *
 * Unit-covered in `src/lib/ad-tool-config.physical-size-cue.test.ts`.
 */
export function physicalSizeCue(dims: PhysicalDimensionsLite | null | undefined): string {
  if (!dims) return "";
  const rawShape = typeof dims.shape === "string" ? dims.shape.trim() : "";
  const shape = rawShape || "package";
  const axes = [dims.length_in, dims.width_in, dims.height_in]
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0)
    .sort((a, b) => b - a);
  if (axes.length < 2) return "";
  const [larger, smaller] = axes;
  const round = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return ` The ${shape} is real-world ${round(larger)} inches by ${round(smaller)} inches — render it true-to-life at that physical size against the hand and fingers (do NOT shrink it to a small-package size; a hand span is roughly ${round(larger)} inches, so the ${shape} should fill the hand accordingly).`;
}
