---
name: deploy
description: Use before committing/pushing ShopCX code that should reach production — the safe-shipping checklist. Gate on npx tsc --noEmit, branch (never commit to main directly), never push during active Inngest syncs (a Vercel deploy reaps in-flight functions), and rebuild portals/Remotion when their source changed. Triggered by "ship/deploy/push this" or finishing a change destined for prod.
---

# deploy

Get a change to production without breaking the live system. Vercel auto-deploys on push to `main`; the risk isn't the push, it's pushing broken types, pushing mid-sync (which kills running Inngest functions), or shipping a source edit whose built artifact you forgot to regenerate.

## Procedure

1. **Gate on types.** `npx tsc --noEmit` must pass. **Never** commit/push on a failing build — fix the errors first. (Note: `scripts/` is excluded from `tsc`, so a script's type errors won't show here — still run the script if it's load-bearing.)
2. **Regenerate built artifacts whose source you touched** — committing source without the rebuilt bundle ships a stale customer-facing artifact:
   - edited `shopify-extension/portal-src/` → `node scripts/build-all-portals.js`, then commit the built bundles (and `shopify app deploy --force` from inside `shopify-extension/` for the theme extension — see [[operational-rules]] § Shopify extension deploy).
   - edited anything under `remotion/` → `npx tsx scripts/deploy-remotion-lambda.ts` (Lambda renders the *deployed* site; skip it and prod renders a stale composition).
3. **Branch — never commit to `main` directly.** Work on a `claude/{slug}-{short}` (or feature) branch off the default branch. Code never auto-merges; the owner squash-merges from `/dashboard/branches`.
4. **Confirm Inngest syncs are drained before pushing.** A push to `main` triggers a Vercel production deploy, and **Vercel reaps in-flight serverless functions** — a running Shopify/Appstle sync gets killed mid-flight. Don't push during an active sync; wait for it to finish.
5. **Apply migrations in the same session as the code that needs them** ([[operational-rules]] § Migrations — always apply them). A committed-but-unapplied migration means new code reading the new columns 500s against the live DB until some later deploy. Use [[write-migration]] (and under the box worker, request approval to apply — you have no prod creds).
6. **Scope the commit** to its one feature; leave the owner's unrelated in-progress edits uncommitted. New feature/table/inngest/lib/integration → its brain page lands in the **same** commit ([[write-brain-page]]).

## Guardrails

- **`npx tsc --noEmit` before every commit** — the single non-negotiable gate.
- **Branch, never `main`.** Direct commits to `main` deploy straight to production with no review.
- **Never push during active Inngest syncs.** This is the most common way to break a live sync.
- **The owner reviews on the live deployment, not localhost.** "Can't see the change" almost always means undeployed, not missing — ship it, don't spin up a local demo.
- **Under the box worker the harness owns git/PR** — make the edits + pass `tsc`, then emit your status JSON; the worker handles branch/commit/PR. Gated prod actions (migrations, prod scripts) → `needs_approval`, never run them yourself. Locally/interactively you may commit + push the branch directly.
- Keep Gorgias out of `src/`; never `git add .env.local`.

## Related
`docs/brain/operational-rules.md` (§ Inngest + Vercel patterns · Migrations · Shopify extension deploy · Remotion site deploy) · skills: `build-spec`, `write-migration`, `write-brain-page` · `CLAUDE.md` (§ Local conventions)
