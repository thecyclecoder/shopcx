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

- `new/` → avatar create. **Photo-free by default.** Reachable with `?productId=` (from the builder — pre-fills gender/age from THAT product's dominant buyer archetype via `GET /api/ads/avatars/archetypes`, plus a chip row of the product's archetypes to switch among) OR `?proposalId=` (pre-fills from a confirmed proposal). Flow: set the four controls (**gender, age, health level, ethnicity** — gender + age pre-filled from the product's buyers) → **"Generate 3 faces"** (Soul text-to-image, ~3cr each) → every generated face is saved to the reusable library ([[../tables/ad_avatar_candidates]]) → pick one + name → **Create** mints the 40cr / $2.50 character. The screen lists the existing face library first (deletable) so the operator reuses a look instead of regenerating. Uploading 1-5 reference photos is now an **optional fallback**.
- `proposals/new/` → operator-initiated "Suggest avatars for product X" form → `generateAvatarProposals` (Opus-only, no Higgsfield spend; default **5** archetypes).

## API endpoints called

- `GET /api/ads/avatars` — active avatar list
- `POST /api/ads/avatars` — create avatar (calls `createCharacter`; accepts `candidateId` to tag the chosen face `used` + link `used_avatar_id`; sets the proposal's `confirmed_avatar_id` when `proposalId` given). **40-credit character minted only here, on Create.**
- `PATCH /api/ads/avatars/{id}` — archive / rename
- `POST /api/ads/avatars/candidates` — generate N faces from the four attributes via Soul text-to-image + save each to the library
- `GET /api/ads/avatars/candidates` — list the saved face library (re-signed URLs, excludes `discarded`)
- `DELETE /api/ads/avatars/candidates?id=…` — delete a saved face (row + storage object)
- `GET /api/ads/avatars/archetypes?productId=…` — the selected product's buyer archetypes (gender/age/share), Opus-free (reads the `demographics_snapshots.archetype_tuples` cache via `getProductArchetypes`), to pre-fill the face dropdowns
- `POST /api/ads/avatars/upload` — upload reference photos to the private bucket (optional fallback path)
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

[[../lifecycles/ad-render]] · [[../lifecycles/demographic-enrichment]] · [[../tables/ad_avatars]] · [[../tables/ad_avatar_proposals]] · [[../tables/ad_avatar_candidates]] · [[../integrations/higgsfield]] · [[../recipes/create-avatar]]

---

[[../README]] · [[../../CLAUDE]]
