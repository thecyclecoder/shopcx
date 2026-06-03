# libraries/ad-tool-config

Ad tool — **single source of truth** for the direct-response frameworks the generator, validator, and renderer all share. Keeping these here (not scattered across prompts/components) means the hook list, LF8 framework, format matrix, and safe-zone numbers can't drift between subsystems.

**File:** `src/lib/ad-tool-config.ts` · Consumed by [[ad-angles]], [[ad-validator]], [[ad-script]], [[ad-render]], [[../inngest/ad-tool]].

## Exports

| Export | What |
|---|---|
| `LIFE_FORCE_8` | Cashvertising's 8 primal desires (slot → label) |
| `HOOK_FORMULAS` (×12) + `HOOK_SLUGS` | the 12 hook formulas (slug, template, lever, bestForLf8, spokenHook) |
| `URGENCY_LEVERS` / `VIBE_TAGS` | allowed enums (`UrgencyLever`, `VibeTag`) |
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

## Gotchas

- **LF8 #4 (sexual companionship) is OFF by default** in `DEFAULT_AD_TOOL_SETTINGS.lf8_allowed` — a brand must opt in.
- Safe zones differ by **format AND media kind** — Reels video reserves 14% top / 35% bottom; statics get a 20% bottom. Always pass `kind` to `safeCore`.
- `resolveAdToolSettings` falls back to defaults for any empty/missing array field — never trust a partial stored object directly.

---

[[../README]] · [[../../CLAUDE]] · [[../tables/workspaces]]
