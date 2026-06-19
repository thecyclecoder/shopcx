---
name: edit-shopify-theme
description: Use to change the live Superfoods Shopify storefront theme from ShopCX — the GitHub-repo-is-source-of-truth, preview-first, reconcile-before-commit flow via src/lib/shopify-theme.ts. Triggered by "edit/update the storefront theme/PDP/homepage", a copy/section/CSS tweak to the live store, or "the theme repo and live store have drifted".
---

# edit-shopify-theme

Change the live Shopify store by committing to its **GitHub repo** — Shopify's GitHub integration auto-deploys `thecyclecoder/theme-superfoodscompany.com@master` to the live MAIN theme. ShopCX *reads* the live theme from Shopify (`read_themes`) and *writes* by committing to the repo (`GITHUB_TOKEN`). A short-term bridge until the in-house storefront retires Shopify. Lib: `src/lib/shopify-theme.ts`.

## Procedure

1. **Read current content from the repo, not a checkout.** The local working folder was retired — the GitHub repo is the sole source of truth.
   ```ts
   import { getLiveTheme, readThemeFile, commitThemeFiles } from "@/lib/shopify-theme";
   const { target } = await getLiveTheme(WORKSPACE_ID);          // resolves repo+branch from the MAIN theme name
   const cur = await readThemeFile(target, "sections/main-product.liquid");
   ```
2. **Reconcile first if live and GitHub may have drifted.** Manual edits in the Shopify code editor / customizer (esp. `config/settings_data.json`) leave the repo behind, and Shopify rejects the next commit as out-of-date. Run `npx tsx scripts/reconcile-shopify-theme.ts` (dry run) → `--commit` to re-sync before you commit forward.
3. **Preview-first for risky changes.** Layout, JSON templates, checkout-adjacent, or global CSS/JS → stage on a branch and connect it as an unpublished **preview theme**, eyeball, then merge to `master`:
   ```ts
   import { ensureBranch } from "@/lib/shopify-theme";
   await ensureBranch(target, "master");                         // idempotent
   const staged = { ...target, branch: "homepage-rebuild" };
   await commitThemeFiles(staged, files, "Homepage: DR rebuild v1");
   ```
   Routine copy/section/snippet tweaks can go straight to `master`.
4. **Commit the change.** One atomic commit (multiple files OK; `{path, delete:true}` to remove; `contentBase64` for binary assets). Shopify auto-pulls in ~seconds.
   ```ts
   await commitThemeFiles(target, [{ path: "sections/main-product.liquid", content: next }], "PDP: tighten hero copy");
   ```

## Guardrails

- **Single writer.** While ShopCX owns the theme, do NOT edit in the Shopify code editor / customizer — it diverges from GitHub and Shopify rejects the next commit. If someone did, `reconcile-shopify-theme.ts --commit` re-syncs.
- **JSON files are JSONC.** Shopify serves locales/templates/`settings_data.json` with a leading `/* auto-generated */` header — expected, not a diff. The reconcile script strips it before its semantic-JSON compare (byte compare for liquid/css/js/binary), so don't "fix" the header.
- **Reversible.** Every change is a normal commit — `git revert` on the *theme* repo undoes it and Shopify redeploys.
- **Compose, don't reinvent; bake content as defaults.** A new template orders purpose-built sections + reuses good existing ones; put curated copy/image URLs in schema defaults so it renders right with zero customizer work. Auto-source product images from Shopify `featuredImage`.
- **No prod creds under the box worker.** Author the script; a `--commit` (or any `commitThemeFiles`) touches the live store → request approval (`{"type":"run_prod_script","cmd":"npx tsx scripts/reconcile-shopify-theme.ts --commit"}`) and stop. A dry run still needs creds on the box → request it the same way. Locally/interactively run directly.

## Related
`docs/brain/recipes/edit-shopify-theme.md` · `scripts/reconcile-shopify-theme.ts` · `src/lib/shopify-theme.ts` · skills: `audit-reconcile`, `script-conventions` · `docs/brain/integrations/shopify.md` · `docs/brain/lifecycles/storefront-checkout.md`
