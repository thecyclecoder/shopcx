# Edit the Shopify theme (chat → build → deploy)

Short-term bridge until the in-house storefront retires Shopify. Dylan chats; Claude builds the change and ships it to the live store via a GitHub commit. See [[../specs/shopify-theme-via-shopcx]] and `src/lib/shopify-theme.ts`.

## Model

- **GitHub repo is the source of truth.** `thecyclecoder/theme-superfoodscompany.com@master` → Shopify's GitHub integration auto-deploys commits to the live MAIN theme (`theme-superfoodscompany.com/master`).
- ShopCX **reads** the live theme from Shopify (`read_themes`) and **writes** by committing to the repo (`GITHUB_TOKEN`). The local `theme-superfoodscompany.com/` working folder was **retired 2026-06-16** — the GitHub repo is the sole source of truth (keep a clone only for occasional `Shopify/dawn` upstream merges).

## Workflow

```ts
import { getLiveTheme, readThemeFile, commitThemeFiles } from "@/lib/shopify-theme";

const { target } = await getLiveTheme(WORKSPACE_ID);   // resolves repo+branch from the MAIN theme name
const cur = await readThemeFile(target, "sections/main-product.liquid");
// …edit `cur`…
await commitThemeFiles(target, [{ path: "sections/main-product.liquid", content: next }], "PDP: tighten hero copy");
// Shopify auto-pulls the commit → live in ~seconds.
```

- `commitThemeFiles` is one atomic commit (multiple files OK; `{path, delete:true}` to remove; `contentBase64` for binary assets).
- Read current content from the repo (`readThemeFile`) — it's the source of truth — not from a local checkout.

## Guardrails

- **Single writer.** While ShopCX owns the theme, do NOT edit in the Shopify code editor / customizer — it diverges from GitHub and Shopify rejects the next commit as out-of-date. If someone does (esp. `config/settings_data.json` via the customizer), run `scripts/reconcile-shopify-theme.ts --commit` to re-sync before committing again.
- **Risky changes** (layout, JSON templates, checkout-adjacent, global CSS/JS): stage on a preview theme and eyeball there first, then promote. Routine copy/section/snippet tweaks can go straight to `master`. See **Preview-staging a big change** below.
- **Reversible:** every change is a normal commit — `git revert` on the repo undoes it, Shopify redeploys.
- **JSON files are JSONC** — Shopify serves locales/templates/`settings_data.json` with a leading `/* auto-generated */` comment header; that's expected, not a diff (the reconcile script strips it before comparing).

## Preview-staging a big change

For a large rebuild (new sections, `templates/index.json`, layout), don't commit straight to `master` — stage on a **GitHub side branch + connected Shopify preview theme**:

```ts
import { getLiveTheme, ensureBranch, commitThemeFiles } from "@/lib/shopify-theme";

const { target } = await getLiveTheme(WORKSPACE_ID);
const branchTarget = { ...target, branch: "homepage-rebuild" };
await ensureBranch(branchTarget);                       // create off master, idempotent
await commitThemeFiles(branchTarget, changes, "homepage v1");  // lands on the side branch only
```

- `master` stays untouched, so the live MAIN theme is unaffected while you iterate.
- Dylan connects the side branch as an **unpublished preview theme** in Shopify (Online Store → Themes → Add from GitHub), eyeballs the preview URL, and approves.
- On approval, **merge the branch → `master`**; Shopify's GitHub integration auto-deploys MAIN. Git history stays the immutable record (`git revert` to roll back).
- Curated copy/images are baked as **section schema defaults / `index.json` settings** so the homepage renders correctly with zero customizer work.

**Worked example — direct-response homepage rebuild (verified 2026-06-18).** 9 custom DR sections (`sections/dr-{hero,trust,bestsellers,goals,why,reviews,offer,faq,reorder}.liquid`) + `templates/index.json` + 4 brand-green "as seen on" press-logo assets (`assets/dr-press-{abc,cbs,nbc,fox}.avif`), built end-to-end via this flow on branch `homepage-rebuild`, staged on a preview theme, merged to `master` live. Tabs-led hero, bestsellers grid, "what's your goal?" router, trust bar, guarantee, S&S value stack. Product shots auto-sourced from each product's Shopify `featuredImage`; no manual uploads. This added `ensureBranch` to `src/lib/shopify-theme.ts`.

## Reconciliation

`scripts/reconcile-shopify-theme.ts` exports the live theme and commits any files whose content genuinely differs from the repo (semantic JSON compare; byte compare for liquid/css/js/binary). Dry-run by default; `--commit` to push. Run it whenever live and GitHub may have drifted (e.g. after manual editor edits). It only adds/updates — never deletes repo files missing from live.

## Related

[[../integrations/shopify]] · [[../specs/shopify-theme-via-shopcx]] · [[../lifecycles/storefront-checkout]]
