# libraries/ad-tool-config

Ad tool — **single source of truth** for the direct-response frameworks the generator, validator, and renderer all share. Keeping these here (not scattered across prompts/components) means the hook list, LF8 framework, format matrix, and safe-zone numbers can't drift between subsystems.

**File:** `src/lib/ad-tool-config.ts` · Consumed by [[ad-angles]], [[ad-validator]], [[ad-script]], [[ad-render]], [[../inngest/ad-tool]].

## Exports

| Export | What |
|---|---|
| `LIFE_FORCE_8` | Cashvertising's 8 primal desires (slot → label) |
| `HOOK_FORMULAS` (×12) + `HOOK_SLUGS` | the 12 hook formulas (slug, template, lever, bestForLf8, spokenHook) |
| `URGENCY_LEVERS` / `VIBE_TAGS` | allowed enums (`UrgencyLever`, `VibeTag`) |
| `AD_SCENE_STYLES` + `DEFAULT_SCENE_STYLE` + `getSceneStyle(value)` | scene presets (`outdoor_selfie`/`kitchen_counter`/`walk_and_talk`/`living_room_couch`/`car_front_seat`/`home_desk`); each has a `hero` clause (→ holding-product image prompt) + `motion` clause (→ Veo talking-head prompt). Stored on [[../tables/ad_campaigns]]`.scene_style`. See [[../lifecycles/ad-render]]. |
| `AVATAR_BROLL_ACTIONS` + `getAvatarBrollAction(value)` | avatar b-roll presets (`making_instant_coffee`/`sipping_coffee`/`opening_bag`/`holding_chaga`/`holding_cordyceps`/`mirror_looser_clothes`); each has `usesProduct`, a `still` prompt (→ Nano Banana combine action frame) + `motion` prompt (→ Veo). Drives [[../inngest/ad-tool]] b-roll `mode="avatar"`. `{product}` → product title. |
| `DEFAULT_BANNED_WORDS` | soft words rejected by default (supports, helps, natural, boost…) |
| `BANNED_OPENERS` / `SOFT_CTA_PHRASES` | warm-intro words + soft CTAs the validator rejects |
| `CAPTION_STYLES` + `CAPTION_SPEC` | Hormozi caption style enum + font/size/color/stroke spec |
| `FORMAT_SPECS` + `safeCore(format, kind)` | per-format dims + video/static safe zones → px safe-core rect |
| `VIDEO_FORMATS` / `STATIC_FORMATS` | the four outputs every ad produces |
| `STATIC_TEMPLATES` | brutalist/receipt/newspaper/meme/ingredient-stack |
| `MOTION_PRESETS` + `eligibleMotions(vibeTags)` | DoP b-roll motion presets, biased jarring unless purely clinical |
| `META_CAPS` | `{ headline:40, primary_text:125, description:30 }` |
| `MAX_SPOKEN_SECONDS` (30), `MAX_AVATARS_PER_WORKSPACE` (10), `DEFAULT_COST_CAP_CENTS` (1000 = $10/ad) | hard caps |
| `AdToolSettings` + `DEFAULT_AD_TOOL_SETTINGS` + `resolveAdToolSettings(stored)` | per-workspace settings shape (`workspaces.ad_tool_settings`), merged over defaults |
| `slugify(name)` | name → snake_case slug (used for `ingredient_*` media slots) |
| `physicalSizeCue(dims)` + `PhysicalDimensionsLite` | derives the real-world size clause injected into `buildHoldingProductPrompt` in [[../inngest/ad-tool]] so the Nano Banana Pro combine renders the product true-to-life against the hand (a 6"×5" box occupies a realistic fraction of the frame, not shrunk to drink-can size). Uses the two largest of `length_in`/`width_in`/`height_in` (visible-face axes) so the cue is stable regardless of which axis was called "height". Returns an empty string when dims are missing/partial (safe fallback — no crash, no broken sentence). Unit-covered in `src/lib/ad-tool-config.physical-size-cue.test.ts`. See [[../lifecycles/ad-render]] Phase 0 + Phase 3 hero. |

### Avatar face generation (text-to-image)

| Export | What |
|---|---|
| `AVATAR_GENDERS` | `["female", "male"]` (+ `AvatarGender` type) — pre-filled from the buyer cohort |
| `AVATAR_AGE_RANGES` | `["under_25", "25-34", "35-44", "45-54", "55-64", "65+"]` (+ `AvatarAgeRange` type) — **mirrors `customer_demographics.inferred_age_range` bands**; pre-filled from the cohort |
| `AVATAR_HEALTH_LEVELS` | `athletic` \| `fit` \| `average` \| `relatable`, each `{ value, label, prompt }` where `prompt` is the body/appearance fragment baked into the portrait prompt |
| `AVATAR_ETHNICITIES` | `auto` (model chooses) + all major ethnicities, each `{ value, label, prompt }`. **Operator-picked — NO race lookup** (we have no ethnicity data to infer from) |
| `AvatarFaceAttributes` | `{ gender, ageRange, healthLevel, ethnicity }` — the four controls |
| `buildAvatarPortraitPrompt(attrs, context, angleVariant)` | builds a photorealistic UGC-style Soul text-to-image prompt from the four attributes (+ optional cohort `context`); `angleVariant` rotates the camera angle so the 3 generated faces differ. No text/watermark/product in frame. |

## Gotchas

- **LF8 #4 (sexual companionship) is OFF by default** in `DEFAULT_AD_TOOL_SETTINGS.lf8_allowed` — a brand must opt in.
- Safe zones differ by **format AND media kind** — Reels video reserves 14% top / 35% bottom; statics get a 20% bottom. Always pass `kind` to `safeCore`.
- `resolveAdToolSettings` falls back to defaults for any empty/missing array field — never trust a partial stored object directly.

---

[[../README]] · [[../../CLAUDE]] · [[../tables/workspaces]]
