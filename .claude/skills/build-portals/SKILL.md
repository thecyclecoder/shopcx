---
name: build-portals
description: Use after editing shopify-extension/portal-src/ in ShopCX — rebuild both portal bundles so the customer-facing artifact isn't stale. Runs node scripts/build-all-portals.js (Shopify extension portal + mini-site portal). CLAUDE.md hard rule. Triggered by any change under shopify-extension/portal-src/, or "the portal/mini-site doesn't show my change".
---

# build-portals

`shopify-extension/portal-src/` is **source**; the live portals run from **built bundles**. Edit the source and the change is invisible until you rebuild — so committing the source without the regenerated bundle ships a stale subscriber-facing portal. One command builds both targets.

## What gets built

`node scripts/build-all-portals.js` (from the repo root) builds two bundles from the one source tree:
1. **Shopify extension portal** — endpoint `/apps/portal-v2` (`shopify-extension/build-portal.js` + the SCSS → `extensions/subscriptions-portal-theme/assets/portal.min.css`).
2. **Mini-site portal** — endpoint `/api/portal` (`scripts/build-minisite-portal.js`).

Mini-site and live chat must produce **identical** ticket messages — only rendering differs (CLAUDE.md) — so both bundles come from the same source and must be rebuilt together.

## Procedure

1. **Edit the source** under `shopify-extension/portal-src/` (JS/TS + `styles/portal.scss`). Never hand-edit a built bundle (`assets/portal.min.*`, the minified output) — it's overwritten on the next build.
2. **Rebuild both bundles.** From the repo root: `node scripts/build-all-portals.js`. It shells out to the extension build, the SASS compile, and the mini-site build in turn, failing loud (`stdio: inherit`) if any step errors.
3. **Commit source + built bundles together.** The regenerated `portal.min.css` / bundle JS land in the **same** commit as the source edit — otherwise the deploy ships a stale artifact.
4. **Deploy the theme extension if the extension portal changed.** A new bundle reaches the live Shopify extension only via `shopify app deploy --force` from inside `shopify-extension/` (see [[deploy]] § Shopify extension deploy). The mini-site bundle deploys with the normal Vercel push.

## Guardrails

- **Source edit ⇒ rebuild, no exceptions.** This is the most common "my change didn't show up" cause — the bundle is stale. Part of the [[deploy]] checklist's "regenerate built artifacts whose source you touched."
- **Run from the repo root.** The script resolves `shopify-extension/` and `scripts/` relative to itself; running it from elsewhere is fine, but invoke it as `node scripts/build-all-portals.js`.
- **Don't commit only the source.** Source-without-bundle = stale prod portal. Commit both, in one commit.
- **Pure local build, no DB/prod creds** — safe to run under the box worker. The *deploy* of the result (Vercel push, `shopify app deploy`) is the gated step, not the build.

## Related
`scripts/build-all-portals.js` · `shopify-extension/build-portal.js` · `scripts/build-minisite-portal.js` · skills: `deploy` · `docs/brain/operational-rules.md` (§ Shopify extension deploy) · `CLAUDE.md` (§ Portal builds)
