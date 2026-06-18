# Archive — verified, retired specs

The browsable archive of features that shipped **and** were **owner-verified in production**, then folded into their permanent brain homes and deleted from `specs/`. This is the visual index behind the roadmap board's **Archived** section ([[dashboard/roadmap]]).

A spec lands here only after the [[project-management]] lifecycle's final gate: `shipped → verified → fold + delete + archive-index`. **Verified** is an owner-only, human gate ("I tested it in production and it works"), distinct from **Shipped** (built + deployed, stamped automatically by the build pipeline). The fold-build appends the entry, `git rm`s the spec, and opens a PR; merging it retires the feature.

Nothing here is lost: the durable knowledge lives in the linked lifecycle/table/dashboard page, and the deleted spec is always `git show`-recoverable. To extend or fix an archived feature, use **New spec from brain** (re-hydration) — it drafts a *fresh* spec from the *current* brain page, not the stale snapshot.

## Index

One line per verified feature, newest first. Format: `**Title** · verified {YYYY-MM-DD} · → [[lifecycles/{slug}]]` (link to the feature's primary lifecycle / brain home).

<!-- archive-index: the board parses the list items below; keep the `· verified {date} · → [[link]]` shape -->

- **Storefront: survey chapter + converter-first PDP reorder** · verified 2026-06-18 · → [[lifecycles/storefront-checkout]]
- **Authoring chat grounding — give the Roadmap Opus chat live brain access** · verified 2026-06-18 · → [[lifecycles/roadmap-build-console]]
- **Parallel builds (worktree-isolated, 5 lanes)** · verified 2026-06-18 · → [[recipes/build-box-setup]]
- **Appstle pricing heal + migration monitor** · verified 2026-06-18 · → [[lifecycles/subscription-billing]]

## Related

[[project-management]] · [[dashboard/roadmap]] · [[lifecycles/roadmap-build-console]] · [[README]]
