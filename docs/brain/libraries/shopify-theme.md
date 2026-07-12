# libraries/shopify-theme

Read + write the live Shopify theme through ShopCX. Short-term bridge until the in-house storefront retires Shopify.

**File:** `src/lib/shopify-theme.ts`

## Model

GitHub repo is the **source of truth**; Shopify's GitHub integration auto-deploys commits to the connected branch. We **read** the live theme from Shopify (`read_themes`) for reconciliation/verification, and **write** by committing to the repo (`GITHUB_TOKEN`). See [[../recipes/edit-shopify-theme]] + [[../integrations/shopify]] § Theme management.

## Exports

| Export | Purpose |
|---|---|
| `getLiveTheme(workspaceId)` | Resolve the role-MAIN theme; derive `{owner, repo, branch}` from its `{repo}/{branch}` name (owner from `SHOPIFY_THEME_REPO_OWNER`, default `thecyclecoder`). |
| `listLiveThemeFiles(workspaceId, themeId)` | Every file of a theme via the Shopify theme-files GraphQL API (paginated). Text inline; binary as base64; large files fetched from the returned URL. |
| `readThemeFile(target, path)` | One file's UTF-8 content from the connected branch (GitHub Contents API) — the source of truth. `null` on 404. |
| `listRepoFiles(target)` | Map of `path → blob sha` for the branch tree (recursive). |
| `ensureBranch(target, fromBranch="master")` | Create a branch off `fromBranch` if it doesn't exist (idempotent) — used to stage a multi-section change (e.g. the homepage rebuild) on its own branch before promoting to `master`. Connect that branch as a Shopify **preview theme** to eyeball before merging. |
| `commitThemeFiles(target, changes[], message)` | Atomic multi-file commit via the GitHub Git Data API (blobs → tree on `base_tree` → commit → ref). Commits to `target.branch` (pass an `ensureBranch`-created branch to stage). `{path, content}` / `{path, contentBase64}` / `{path, delete:true}`. Shopify auto-deploys the connected branch. |
| `verifyDeployed(workspaceId, expected[])` | Re-export from Shopify; confirm given paths match expected UTF-8 (post-commit sanity for liquid/text). |

Types: `ThemeFile`, `FileChange`, `ThemeTarget`.

## Callers

- `scripts/reconcile-shopify-theme.ts` — export-live → commit-diff-to-repo.
- `scripts/hide-strawberry-lemonade-superfood-tabs-theme.ts` — crisis availability lever, storefront half: extends the customize-flavor Liquid `variant.id ==` exclusion in the **quantity-breaks snippet** so it also excludes Strawberry Lemonade (`42614433480877`), mirroring the mechanism already used to skip Mixed Berry. Then `commitThemeFiles` + `verifyDeployed`. Parallels the portal half in [[portal__mutation-guard]] (`workspaces.portal_config.suppressed_variant_ids`). SL stays ACTIVE in Shopify admin so existing SL subscribers renew — VISUAL PDP suppression only. Pure patch predicates (`patchLiquidVariantExclusion` + JSON/Dawn fallbacks) live in `src/lib/shopify-theme-hidden-variants.ts` with tests alongside.
- Ad-hoc: Claude edits the theme on request (read → edit → `commitThemeFiles`).
- **Homepage rebuild** — `ensureBranch` + `commitThemeFiles` staged 9 direct-response `sections/dr-*.liquid` + `templates/index.json` + 4 press-logo theme assets on a `homepage-rebuild` branch (live `master` untouched), to connect as a Shopify preview theme before promoting. See [[../recipes/edit-shopify-theme]] § Staging a big change.

## Gotchas

- **JSON theme files are JSONC.** Shopify serves locales/templates/sections/`config/settings_data.json` with a leading `/* auto-generated */` comment header. A byte-diff flags every JSON file; compare *parsed* JSON (the reconcile script strips the header first). `verifyDeployed` does an exact compare, so it false-negatives on JSON — use it for liquid/text.
- **Single writer.** While ShopCX/GitHub owns the theme, manual Shopify code-editor/customizer edits diverge and the next commit is rejected as out-of-date. Re-run the reconcile script if that happens.
- **No local folder.** The sibling `theme-superfoodscompany.com/` working folder was retired 2026-06-16 — the GitHub repo is the sole source of truth. (Keep a clone only for occasional `Shopify/dawn` upstream merges.)
- Owner isn't in the theme name; `repo` + `branch` are. Falls back to `SHOPIFY_THEME_REPO` / `SHOPIFY_THEME_BRANCH` env if the MAIN theme isn't GitHub-named.

## Related

[[../integrations/shopify]] · [[../recipes/edit-shopify-theme]] · [[../lifecycles/storefront-checkout]]
