# Settings · settings/ad-tool

Per-workspace ad-tool configuration. All fields persist to `workspaces.ad_tool_settings` (jsonb), merged over the defaults by `resolveAdToolSettings` in `src/lib/ad-tool-config.ts`. Drives the angle generator, the DR validator's banned-word list, and the renderer's credibility row.

**Route:** `/dashboard/settings/ad-tool`

## Features

**Page title:** Ad tool

**Controls (→ `ad_tool_settings` key):**
- **Banned words** (`banned_words[]`) — soft words the angle generator + validator reject (default: supports, promotes, helps, may aid, natural, wellness, boost, enhance).
- **LF8 toggles** (`lf8_allowed[]`) — which Life Force 8 slots the brand may target (default: all except #4 sexual companionship).
- **Ugly intensity** (`ugly_intensity`) — `mild` / `heavy` / `extreme` (default `heavy`).
- **Default caption style** (`default_caption_style`) — `hormozi_yellow` / `hormozi_white` / `clean_white`.
- **Default urgency per category** (`default_urgency_by_category`) — pin a recurring urgency lever per product category.
- **Pinned credibility badges** (`pinned_badges[]`, ordered) — which trust chips always lead the credibility row (default: Made In The USA, Non-GMO, 3rd Party Tested).
- **Cost cap** (`cost_cap_cents`) — max per-ad spend; default $10. Builder warns + requires confirm when an estimate exceeds it.

**Rendering:** `"use client"` component (client-side state + fetch).

## API endpoints called

- `GET /api/workspaces/{id}/ad-tool-settings` — load resolved settings
- `PATCH /api/workspaces/{id}/ad-tool-settings` — save partial settings (merged over defaults)

## Permissions

Owner / admin.

## Files touched

- `src/app/dashboard/settings/ad-tool/page.tsx` — the settings page
- `src/app/api/workspaces/[id]/ad-tool-settings/route.ts` — get / patch
- `src/lib/ad-tool-config.ts` — `AdToolSettings` shape + `resolveAdToolSettings` + defaults

## Related

[[../lifecycles/ad-render]] · [[../libraries/ad-angles]] · [[../libraries/ad-validator]] · [[../tables/workspaces]]

---

[[../README]] · [[../../CLAUDE]]
