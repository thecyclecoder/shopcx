# Create an ad avatar

How to mint a persistent Higgsfield spokesperson character for the ad tool. The avatar is matched to the product's *actual buyer* via the demographic-enrichment pipeline, confirmed by the operator, then created from 1-5 reference photos. Characters cost real money (40 credits / $2.50), so the flow is propose → confirm → create, never auto-spend.

## Steps

1. **Suggest avatars for a product.** On `/dashboard/marketing/ads/avatars` → `proposals/new`, pick a product and run "Suggest avatars". This calls `generateAvatarProposals(productId)` in `src/lib/ad-avatar-proposals.ts` — Opus-only, single-digit cents, **no Higgsfield spend**. It reads only the four-field demographic tuple (`inferred_gender`, `inferred_age_range`, `inferred_life_stage`, `zip_income_bracket`) from [[../tables/customer_demographics]] for the link-deduped buyer cohort (see [[../lifecycles/demographic-enrichment]]). Cohort < 30 falls back to the workspace-wide [[../tables/demographics_snapshots]]. Writes [[../tables/ad_avatar_proposals]] rows (`status='proposed'`).

2. **Confirm a proposal.** Top of `/dashboard/marketing/ads/avatars`, each proposal card shows the archetype + demographic basis. "Confirm + upload photos" carries the brief into the create page.

3. **Upload 1-5 reference photos.** On `avatars/new`, name the avatar and upload PNG/JPG/WEBP photos of the on-camera person. They land in the **private** `ad-tool` bucket (`avatars/{workspace_id}/...`); Higgsfield gets 1h signed URLs at create time, never public URLs.

4. **Create the character.** `POST /api/ads/avatars` calls `createCharacter` in `src/lib/higgsfield.ts` → mints a `higgsfield_character_id`, spends **40 credits ($2.50)**, writes an [[../tables/ad_avatars]] row (`cost_cents ≈ 250`), and — if `proposalId` was passed — sets the proposal's `confirmed_avatar_id` + `status='confirmed'` (lineage via `ad_avatars.proposed_from_id`).

## Gotchas

- **10-avatar cap per workspace** (`MAX_AVATARS_PER_WORKSPACE`). The manager surfaces archive-to-replace rather than letting avatars accumulate — reuse over re-create.
- **No public buckets.** Reference photos stay private; signed URLs (1h TTL) are issued only for the Higgsfield call.
- **NSFW handling.** Higgsfield can return `status='nsfw'`; this still bills on their side. The job is preserved on [[../tables/ad_jobs]] and surfaced to the operator — refine the photos/prompt and retry.
- **Owner / admin only.** Other roles can see avatars but can't create or delete.
- Requires Higgsfield connected (Settings → Integrations) and `workspaces.ad_tool_enabled=true`.

## Related

[[../lifecycles/ad-render]] · [[../integrations/higgsfield]] · [[../tables/ad_avatars]] · [[../tables/ad_avatar_proposals]] · [[../dashboard/marketing__ads__avatars]] · [[generate-ad]]
