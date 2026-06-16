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
| `commitThemeFiles(target, changes[], message)` | Atomic multi-file commit via the GitHub Git Data API (blobs → tree on `base_tree` → commit → ref). `{path, content}` / `{path, contentBase64}` / `{path, delete:true}`. Shopify auto-deploys it. |
| `verifyDeployed(workspaceId, expected[])` | Re-export from Shopify; confirm given paths match expected UTF-8 (post-commit sanity for liquid/text). |

Types: `ThemeFile`, `FileChange`, `ThemeTarget`.

## Callers

- `scripts/reconcile-shopify-theme.ts` — export-live → commit-diff-to-repo.
- Ad-hoc: Claude edits the theme on request (read → edit → `commitThemeFiles`).

## Gotchas

- **JSON theme files are JSONC.** Shopify serves locales/templates/sections/`config/settings_data.json` with a leading `/* auto-generated */` comment header. A byte-diff flags every JSON file; compare *parsed* JSON (the reconcile script strips the header first). `verifyDeployed` does an exact compare, so it false-negatives on JSON — use it for liquid/text.
- **Single writer.** While ShopCX/GitHub owns the theme, manual Shopify code-editor/customizer edits diverge and the next commit is rejected as out-of-date. Re-run the reconcile script if that happens.
- **No local folder.** The sibling `theme-superfoodscompany.com/` working folder was retired 2026-06-16 — the GitHub repo is the sole source of truth. (Keep a clone only for occasional `Shopify/dawn` upstream merges.)
- Owner isn't in the theme name; `repo` + `branch` are. Falls back to `SHOPIFY_THEME_REPO` / `SHOPIFY_THEME_BRANCH` env if the MAIN theme isn't GitHub-named.

## Related

[[../integrations/shopify]] · [[../recipes/edit-shopify-theme]] · [[../specs/shopify-theme-via-shopcx]]
