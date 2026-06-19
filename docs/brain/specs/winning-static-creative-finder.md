# Winning Static-Creative Finder ⏳

**Owner:** [[../functions/growth]] · **Parent:** Growth mandate "Static-ad optimization"

Continuously source **proven winning static ad creative** — first from **our own** top-performing statics (we have the data), then from **competitors / the health-&-wellness category** via the Meta Ad Library — and drop the best candidates into an **ideas bin**, so the team always has a pipeline of references to turn into more killer statics. First concrete spec under Growth's perpetual static-ad-optimization mandate; feeds the variant-generation / scaling specs that come after.

## Source feasibility (tested 2026-06-19)
- ✅ **Our own ads** — accessible now via the workspace Meta connection + the `meta_campaigns/adsets/ads/insights_daily` tables ([[storefront-iteration-engine]]). We have spend/ROAS/longevity → a *true* winner signal.
- ⛔ **Meta Ad Library API (`ads_archive`)** — **blocked until identity confirmation.** Tested: app token → `code 10 "app role required"`; workspace user token → `subcode 2332002 "follow the steps at facebook.com/ads/library/api"`. It's a one-time **KYC gate** (confirm identity + location at `facebook.com/ads/library/api`), then a user token works. Not a code problem.
- **Commercial Ad Library ads carry NO spend/impressions** (those fields are political-ads-only). So the external winner signal is **longevity** (days running — advertisers kill losers fast) + variation count, not ROAS.
- **Fallbacks before/without confirmation:** the public Ad Library *UI* (a human browses + drops references) or a paid ad-spy API (Foreplay / AdSpy / BigSpy) — those aggregate the library + add longevity/scale signals.

## Phase 1 — Ideas bin + OUR-OWN winners (feasible now) ⏳
- ⏳ `creative_ideas` table — card shape: `source` (`own | ad_library | manual | adspy`), `image/asset` (ref/screenshot, never a lifted asset), `why_it_won` (signal + value), `tags`, `status` (`new | shortlisted | in_production | shipped`), `page/advertiser`, `first_seen`/`days_running`. Migration via [[write-migration]].
- ⏳ Rank **our** static ads by **ROAS + longevity** from `meta_insights_daily` → auto-add winners to the bin (`source='own'`, `why_it_won` = ROAS + days-live). Runs as a scheduled job (Inngest) or piggybacks the storefront-iteration-engine pull.

## Phase 2 — External discovery (Meta Ad Library, gated) ⏳
- ⏳ **Prerequisite:** owner completes `facebook.com/ads/library/api` identity+location confirmation (one-time). Document it in [[../integrations/meta]].
- ⏳ Once unlocked: pull active statics by (a) a **curated competitor `search_page_ids` list** (health-&-wellness brands) and (b) **category `search_terms`** (e.g. "greens powder", "collagen", "gut health"), `ad_reached_countries=['US']`, `ad_active_status=ACTIVE`, image-only. Rank by **longevity** (`ad_delivery_start_time` → days running) → add long-runners to the bin as references (`source='ad_library'`, `why_it_won` = days running + still active).
- ⏳ **Interim/fallback (no confirmation):** a manual "add from Ad Library URL" capture in the bin, and/or an adspy-API adapter behind the same `creative_ideas` shape — so external discovery isn't blocked on the KYC.

## Phase 3 — Surface + workflow ⏳
- ⏳ Dashboard **Ideas bin** view — browse / filter (source, tag, days-running) / shortlist / promote to production. Sortable by the why-it-won signal.
- ⏳ Hook for the next mandate spec (variant generation) to pull from `shortlisted` ideas.

## Safety / invariants
- **External creative is reference/inspiration, never lifted** — store the concept + a link/screenshot for analysis; never republish a competitor's asset.
- **Own-winner ranking uses our real spend/ROAS; external uses longevity** (no spend data in the commercial Ad Library — don't fake a ROAS for external).
- No-orphan: owner = [[../functions/growth]], parent = the static-ad-optimization mandate.

## Completion criteria
- Our own winning statics land in the bin automatically, ranked by ROAS + longevity, browsable/promotable.
- External references (Ad Library once confirmed, or manual/adspy until then) land in the same bin, ranked by longevity.
- The bin is the documented feed for variant-generation.

## Related
[[storefront-iteration-engine]] · [[killer-statics]] · [[advertorial-landers]] · [[../functions/growth]] · [[../integrations/meta]] · [[../tables/agent_jobs]]
