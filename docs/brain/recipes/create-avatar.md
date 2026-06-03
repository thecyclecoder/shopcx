# Create an ad avatar

How to mint a persistent Higgsfield spokesperson character for the ad tool — **no photo uploads required**. The avatar is matched to the product's *actual buyer* via the demographic-enrichment pipeline, then the operator generates faces from four controls and picks one. Characters cost real money (40 credits / $2.50), so the flow is propose → generate faces → pick → create, never auto-spend.

## Steps

1. **Suggest avatars for a product.** On `/dashboard/marketing/ads/avatars` → `proposals/new`, pick a product and run "Suggest avatars". This calls `generateAvatarProposals(productId)` in `src/lib/ad-avatar-proposals.ts` — Opus-only, single-digit cents, **no Higgsfield spend** — and returns **5** archetype descriptions. It reads only the four-field demographic tuple (`inferred_gender`, `inferred_age_range`, `inferred_life_stage`, `zip_income_bracket`) from [[../tables/customer_demographics]] for the link-deduped buyer cohort (see [[../lifecycles/demographic-enrichment]]). Cohort < 30 falls back to the workspace-wide [[../tables/demographics_snapshots]]. Writes [[../tables/ad_avatar_proposals]] rows (`status='proposed'`).

2. **Pick a proposal.** Top of `/dashboard/marketing/ads/avatars`, each proposal card shows the archetype + demographic basis. Confirming carries the brief into the create page and **pre-fills gender + age** from the archetype's own tuple.

3. **Set the four controls + generate 3 faces.** On `avatars/new`, set **gender, age, health level, ethnicity** (gender + age pre-filled from the cohort; health level = athletic/fit/average/relatable; ethnicity = auto or an explicit pick). Hit **"Generate 3 faces"** → `POST /api/ads/avatars/candidates` calls `generateSoulPortrait` ([[../libraries/higgsfield]]) — Soul **text-to-image**, ~3 credits per face (~9cr for 3). Every face is saved to the reusable **library** ([[../tables/ad_avatar_candidates]]) in the **private** `ad-tool` bucket, so you don't re-spend credits regenerating the same look. The library is listed first; faces are **deletable**.

4. **Create the character.** Pick one face, name the avatar, hit **Create**. `POST /api/ads/avatars` (with the chosen `candidateId`) calls `createCharacter` in `src/lib/higgsfield.ts` → mints a `higgsfield_character_id`, spends **40 credits ($2.50)**, writes an [[../tables/ad_avatars]] row (`cost_cents ≈ 250`), tags the chosen candidate `status='used'` (+ `used_avatar_id`), and — if `proposalId` was passed — sets the proposal's `confirmed_avatar_id` + `status='confirmed'` (lineage via `ad_avatars.proposed_from_id`).

5. **(Optional fallback) Upload reference photos.** If you'd rather use real photos of a specific on-camera person, upload 1-5 PNG/JPG/WEBP files instead of generating faces. They land in the same **private** `ad-tool` bucket (`avatars/{workspace_id}/...`); Higgsfield gets 1h signed URLs at create time, never public URLs.

## Gotchas

- **Connect Higgsfield first** (Settings → Integrations) and set `workspaces.ad_tool_enabled=true` — face generation calls Soul per-workspace.
- **Faces are reusable** — the saved library means you never re-spend Soul credits regenerating the same look; delete faces you don't want.
- **10-avatar cap per workspace** (`MAX_AVATARS_PER_WORKSPACE`). The manager surfaces archive-to-replace rather than letting avatars accumulate — reuse over re-create.
- **No public buckets.** Generated faces + reference photos stay private; signed URLs (1h TTL) are issued only for the Higgsfield call (and re-signed on each library read).
- **NSFW handling.** Higgsfield can return `status='nsfw'`; this still bills on their side. The job is preserved on [[../tables/ad_jobs]] and surfaced to the operator — refine the attributes/prompt and retry.
- **Owner / admin only.** Other roles can see avatars but can't create or delete.

## Related

[[../lifecycles/ad-render]] · [[../integrations/higgsfield]] · [[../tables/ad_avatars]] · [[../tables/ad_avatar_proposals]] · [[../tables/ad_avatar_candidates]] · [[../dashboard/marketing__ads__avatars]] · [[generate-ad]]
