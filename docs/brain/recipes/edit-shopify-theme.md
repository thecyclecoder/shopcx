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
- **Risky changes** (layout, JSON templates, checkout-adjacent, global CSS/JS): duplicate MAIN to an unpublished preview theme and eyeball there first, then promote. Routine copy/section/snippet tweaks can go straight to `master`.
- **Reversible:** every change is a normal commit — `git revert` on the repo undoes it, Shopify redeploys.
- **JSON files are JSONC** — Shopify serves locales/templates/`settings_data.json` with a leading `/* auto-generated */` comment header; that's expected, not a diff (the reconcile script strips it before comparing).

## Reconciliation

`scripts/reconcile-shopify-theme.ts` exports the live theme and commits any files whose content genuinely differs from the repo (semantic JSON compare; byte compare for liquid/css/js/binary). Dry-run by default; `--commit` to push. Run it whenever live and GitHub may have drifted (e.g. after manual editor edits). It only adds/updates — never deletes repo files missing from live.

## Related

[[../integrations/shopify]] · [[../specs/shopify-theme-via-shopcx]] · [[../lifecycles/storefront-checkout]]
