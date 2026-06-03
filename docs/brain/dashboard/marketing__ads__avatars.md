# Dashboard · marketing/ads/avatars

The avatar manager. Split layout: **Proposals** (top — demographic-driven archetype suggestions, `status='proposed'`) and **Active avatars** (bottom — confirmed [[../tables/ad_avatars]] with thumbnails, last-used date, archive). See [[../lifecycles/ad-render]] Phase 2.

**Route:** `/dashboard/marketing/ads/avatars`

## Features

**Page title:** Avatars

**Layout:**
- **Top — Proposals:** cards from [[../tables/ad_avatar_proposals]] where `status='proposed'`. Each shows the archetype name, suggested wardrobe/setting, the demographic basis ("represents 38% of buyers — female, 35-44, family, 80-100k"), and a "Confirm + upload photos" button. Fallback proposals surface "only N buyers — using workspace-wide demographics."
- **Bottom — Active avatars:** list with archive-to-replace (cap 10).

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `new/` → avatar create: upload 1-5 reference photos + name → `createCharacter` (40cr / $2.50). Reachable from a confirmed proposal (prefilled) or from scratch.
- `proposals/new/` → operator-initiated "Suggest avatars for product X" form → `generateAvatarProposals` (Opus-only, no Higgsfield spend).

## API endpoints called

- `GET /api/ads/avatars` — active avatar list
- `POST /api/ads/avatars` — create avatar (calls `createCharacter`; sets the proposal's `confirmed_avatar_id` when `proposalId` given)
- `PATCH /api/ads/avatars/{id}` — archive / rename
- `POST /api/ads/avatars/upload` — upload reference photos to the private bucket
- `GET /api/ads/proposals` — proposal list
- `POST /api/ads/proposals` — generate proposals for a product (`generateAvatarProposals`)
- `PATCH /api/ads/proposals/{id}` — confirm / reject a proposal

## Permissions

Owner / admin can create / archive. Other roles can view the list.

## Files touched

- `src/app/dashboard/marketing/ads/avatars/page.tsx` — manager (proposals + active)
- `src/app/dashboard/marketing/ads/avatars/new/page.tsx` — photo upload + create
- `src/app/dashboard/marketing/ads/avatars/proposals/new/page.tsx` — suggest avatars

## Related

[[../lifecycles/ad-render]] · [[../lifecycles/demographic-enrichment]] · [[../tables/ad_avatars]] · [[../tables/ad_avatar_proposals]] · [[../integrations/higgsfield]] · [[../recipes/create-avatar]]

---

[[../README]] · [[../../CLAUDE]]
