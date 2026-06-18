# Shopify theme management via ShopCX (AI-driven, short-term)

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Store tech / Shopify"

**Goal:** let Dylan chat with Claude and have theme changes built + shipped to the live Shopify store through ShopCX — **Option A**: ShopCX writes to the theme's GitHub repo and Shopify's GitHub integration auto-deploys. Short-term bridge until the in-house storefront retires Shopify, so kept thin (tooling + scripts, no UI). First, **reconcile** the GitHub repo with manual live edits.

Phase legend: ⏳ planned · 🚧 in progress · ✅ shipped

**Status (2026-06-16): shipped + merged to main.** Reconciliation run + verified (0 remaining diff). Local `theme-superfoodscompany.com/` folder retired/deleted (GitHub is sole source of truth). Brain coverage: [[../libraries/shopify-theme]], [[../recipes/edit-shopify-theme]], [[../integrations/shopify]] § Theme management. Fold this spec into those + delete once the workflow has a few real edits under its belt.

## Context (verified 2026-06-16)

- **Live theme:** `theme-superfoodscompany.com/master`, role MAIN, `gid://shopify/OnlineStoreTheme/153905660077` — GitHub-connected (the `{repo}/{branch}` name).
- **GitHub repo (source of truth):** `thecyclecoder/theme-superfoodscompany.com@master`. Dawn-based.
- **Creds already present:** `read_themes,write_themes` on the Shopify token; `GITHUB_TOKEN` in env.
- **Constraints:** GitHub integration syncs only a branch whose theme is at the repo root (no monorepo subfolder); one writer at a time (GitHub commits vs. live editor edits conflict).

## Phase 1 — Reconcile GitHub with the live theme ✅

`scripts/reconcile-shopify-theme.ts` — exports every live MAIN-theme file and commits those whose content genuinely differs from the repo. **Semantic JSON compare** (Shopify serves theme JSON as JSONC with a `/* auto-generated */` header — stripped before comparing); byte compare for liquid/css/js/binary. Dry-run by default; `--commit` to push. Adds/updates only — never deletes repo files missing from live. Guard: refuses to commit if >50% of files "differ" (encoding-artifact tripwire).

**Run result:** 564 live files; 98 JSON skipped as serialization-only; **32 genuinely-different files committed** (`config/settings_data.json` + ~31 template JSONs — real customizer/app drift) as `71ae3060`. Re-run dry-run → **0 diff**. Deploy is a no-op (committed live's own content) — live store unchanged.

## Phase 2 — Theme tooling library ✅

`src/lib/shopify-theme.ts`: `getLiveTheme` (resolves MAIN + derives repo/branch from its name), `listLiveThemeFiles` (paginated Shopify read, base64 for binary), `readThemeFile` (GitHub, source of truth), `listRepoFiles` (repo tree → blob shas), `commitThemeFiles` (atomic multi-file commit via GitHub Git Data API → auto-deploys), `verifyDeployed`. Write path proven by the reconciliation commit.

## Phase 3 — Workflow + guardrails ✅

[[../recipes/edit-shopify-theme]] documents chat→read→edit→`commitThemeFiles`→deploy, plus guardrails: single-writer (no manual Shopify-editor edits; re-run reconcile if drift), preview-theme-first for risky changes, `git revert` to undo. [[../integrations/shopify]] has a Theme-management section.

## Files

| File | Change |
|---|---|
| `src/lib/shopify-theme.ts` | new — read (Shopify) + commit/verify (GitHub) |
| `scripts/reconcile-shopify-theme.ts` | new — export-live → commit-diff |
| `docs/brain/recipes/edit-shopify-theme.md` | new — workflow + guardrails |
| `docs/brain/integrations/shopify.md` | + Theme management section |

## Decisions (settled 2026-06-16)

- **Option A** (commit to GitHub repo; Shopify auto-deploys), **goal 3** (AI-driven edits driven by Claude Code — no dashboard UI).
- **Deploy target:** routine → `master` direct; risky → preview-theme-then-promote (recipe guardrail).
- **Local `theme-superfoodscompany.com/` folder:** can be retired for edits; keep only for Dawn-upstream merges.

## Related

[[../integrations/shopify]] · [[../recipes/edit-shopify-theme]] · [[../lifecycles/storefront-checkout]]
