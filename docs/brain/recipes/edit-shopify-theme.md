# Edit the Shopify theme (chat → build → deploy)

Short-term bridge until the in-house storefront retires Shopify. Dylan chats; Claude builds the change and ships it to the live store via a GitHub commit. Lib: [[../libraries/shopify-theme]] (`src/lib/shopify-theme.ts`).

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

## Colour schemes — assign an existing one, never mint a new one

Dawn exposes a **fixed set of 21 colour schemes** defined in `config/settings_data.json` under `current.color_schemes`. Sections and blocks reference one by its scheme id (`"color_scheme": "scheme-5a3d8548-…"`), and the customizer's colour picker offers exactly that list.

**Adding a new key to `color_schemes` does not create a usable scheme.** The theme surfaces the pre-defined set; a hand-minted id (e.g. `scheme-cream-ground`) is an orphan that nothing renders, so a section pointed at it silently falls back and the change appears to do nothing. Symptom: you set the scheme, commit, and the page keeps its old background.

The fix is to **assign one of the existing schemes**, or edit that scheme's `background` to the colour you want — accepting that every element already on it changes too, so check what else uses it first:

```bash
grep -o '"color_scheme": *"[^"]*"' templates/*.json sections/*.json | sort | uniq -c | sort -rn
```

Two notes that follow from this:

- **Setting a scheme is one of the few legitimate reasons to use the customizer.** It is easier than hand-editing scheme ids across a JSON template, and Shopify's GitHub integration pushes the resulting `settings_data.json` back to the repo, so the repo stays authoritative afterwards. Confirm with `git fetch && git log origin/master -1 -- config/settings_data.json` rather than assuming.
- **A customizer round-trip prunes orphan schemes.** A hand-added scheme key disappears from `settings_data.json` the next time the customizer writes it — so an orphan is self-cleaning, but anything referencing it breaks first.

Learned 2026-09-28 on the Superfood Tabs PDP: a hand-added `scheme-cream-ground` never rendered; the working fix was assigning an existing scheme whose background was set to `#FBF1E9`.

## Reconciliation

`scripts/reconcile-shopify-theme.ts` exports the live theme and commits any files whose content genuinely differs from the repo (semantic JSON compare; byte compare for liquid/css/js/binary). Dry-run by default; `--commit` to push. Run it whenever live and GitHub may have drifted (e.g. after manual editor edits). It only adds/updates — never deletes repo files missing from live.

## Staging a big change (preview branch) — the homepage rebuild

For a multi-section change you want eyeballed before it goes live, stage it on its own branch instead of committing straight to `master`:

```ts
import { getLiveTheme, ensureBranch, commitThemeFiles } from "@/lib/shopify-theme";
const { target } = await getLiveTheme(WORKSPACE_ID);
await ensureBranch(target, "master");                          // idempotent
const staged = { ...target, branch: "homepage-rebuild" };
await commitThemeFiles(staged, files, "Homepage: DR rebuild v1");
// Connect `homepage-rebuild` as a Shopify PREVIEW theme → eyeball → merge to master to publish.
```

The **homepage rebuild** (direct-response, Tabs-led) shipped this way: 9 custom `sections/dr-*.liquid` (dr-hero, dr-trust, dr-bestsellers, dr-goals, dr-why, dr-reviews, dr-offer, dr-faq, dr-reorder) + `templates/index.json` committed to a `homepage-rebuild` branch (live `master` untouched). Patterns worth reusing:

- **Compose, don't reinvent** — a new `templates/index.json` orders purpose-built DR sections + reuses good existing sections.
- **Bake curated content as section defaults** (image URLs + copy in schema defaults / index settings) so it renders correct with **zero customizer work**.
- **Auto-source images, no uploads** — product shots from each product's Shopify `featuredImage`, hero/lifestyle from the Files library; Nano Banana Pro generation only to fill a genuine gap.
- **Press logos the token can't write to Files** (no `write_files`) go in as **theme assets** (`assets/dr-press-*.avif`, `write_themes`) referenced with `asset_url`.
- On approval, the branch's files land on `master` (MAIN auto-deploys); single-writer rule still applies.

## Related

[[../integrations/shopify]] · [[../libraries/shopify-theme]] · [[../lifecycles/storefront-checkout]] · [[diagnose-slow-storefront-page]]
