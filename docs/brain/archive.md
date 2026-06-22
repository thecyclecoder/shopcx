# Archive — verified, retired specs

The browsable archive of features that shipped **and** were **owner-verified in production**, then folded into their permanent brain homes and deleted from `specs/`. This is the visual index behind the roadmap board's **Archived** section ([[dashboard/roadmap]]).

A spec lands here only after the [[project-management]] lifecycle's final gate: `shipped → verified → fold + delete + archive-index`. **Verified** is an owner-only, human gate ("I tested it in production and it works"), distinct from **Shipped** (built + deployed, stamped automatically by the build pipeline). The fold-build appends the entry, `git rm`s the spec, and opens a PR; merging it retires the feature.

Nothing here is lost: the durable knowledge lives in the linked lifecycle/table/dashboard page, and the deleted spec is always `git show`-recoverable. To extend or fix an archived feature, use **New spec from brain** (re-hydration) — it drafts a *fresh* spec from the *current* brain page, not the stale snapshot.

## Index

One line per verified feature, newest first. Format: `**Title** · verified {YYYY-MM-DD} · → [[lifecycles/{slug}]]` (link to the feature's primary lifecycle / brain home).

<!-- archive-index: the board parses the list items below; keep the `· verified {date} · → [[link]]` shape -->

- **"AI Investigation" — make routine-escalated tickets visible** · verified 2026-06-22 · → [[lifecycles/ticket-lifecycle]]
- **Per-ASIN Amazon Sales + Persistent ASIN→Product/Pack Mapping** · verified 2026-06-22 · → [[tables/daily_amazon_product_snapshots]]
- **Appstle webhook 500 on subscription.billing-* events** · verified 2026-06-22 · → [[integrations/appstle]]
- **Build Console: No Silent No-Op Builds + Report-Issue Enqueue Confirmation** · verified 2026-06-22 · → [[lifecycles/roadmap-build-console]]
- **Clear Escalation Flags on Resolve/Close** · verified 2026-06-22 · → [[lifecycles/ticket-lifecycle]]
- **Comp Transaction Type Constraint Fix** · verified 2026-06-22 · → [[lifecycles/subscription-billing]]
- **Developer Message Center** · verified 2026-06-22 · → [[tables/dev_message_threads]]
- **Proposed-Fix Ships → Auto-Re-test the Origin Spec** · verified 2026-06-22 · → [[lifecycles/roadmap-build-console]]
- **Improve Queue — Mark-as-Read / Dismiss** · verified 2026-06-22 · → [[dashboard/tickets__improve]]
- **Iteration Scorecard Upsert — Stop Swallowing Errors + FK-Resilient** · verified 2026-06-22 · → [[libraries/meta__scorecards]]
- **Migration-Fix: Remove a Line Item (`remove_line` fix_kind)** · verified 2026-06-22 · → [[libraries/migration-fix]]
- **pricing_preserved must account for internal quantity breaks (Appstle baseline lacks them)** · verified 2026-06-22 · → [[lifecycles/subscription-billing]]
- **Portal OTP send-failure returns structured non-5xx, not a 502** · verified 2026-06-22 · → [[lifecycles/customer-portal]]
- **Review Filter Pill Counts — show the real corpus volume** · verified 2026-06-22 · → [[lifecycles/product-intelligence]]
- **Spec-Test JSON Robustness (no silent "no parseable JSON" runs)** · verified 2026-06-22 · → [[lifecycles/roadmap-build-console]]
- **Spec-Test on Ship (event-trigger, cron = backlog)** · verified 2026-06-22 · → [[lifecycles/roadmap-build-console]]
- **Worker Orphan-Reaper — reset in-flight jobs left by a dead worker** · verified 2026-06-22 · → [[recipes/build-box-setup]]
- **Workflow actions own final ticket status — orchestrator must not reopen** · verified 2026-06-22 · → [[lifecycles/ticket-lifecycle]]
- **Base Price Never Above MSRP (invariant + cap)** · verified 2026-06-21 · → [[lifecycles/subscription-billing]]
- **Box-hosted Spec Chat (long-running Max session)** · verified 2026-06-21 · → [[lifecycles/roadmap-build-console]]
- **Box-hosted Ticket "Improve" Agent (Max session)** · verified 2026-06-20 · → [[tables/ticket_improve_chats]]
- **Improve Queue (answered-by-the-box surfacing)** · verified 2026-06-20 · → [[dashboard/tickets__improve]]
- **Authoring chat persistence — save + resume Opus chats (cross-device)** · verified 2026-06-19 · → [[lifecycles/roadmap-build-console]]
- **Brain index refresh — keep archive.md + README counts fresh out-of-band** · verified 2026-06-19 · → [[lifecycles/roadmap-build-console]]
- **Build Approval Gates + Execution Hardening** · verified 2026-06-19 · → [[lifecycles/roadmap-build-console]]
- **Build-box status view — live lanes on the roadmap** · verified 2026-06-19 · → [[lifecycles/roadmap-build-console]]
- **Build-lifecycle hardening — auto-un-draft on completion + no migration re-request loops** · verified 2026-06-19 · → [[lifecycles/roadmap-build-console]]
- **Fold-build batching + conflict-proof brain indexes** · verified 2026-06-19 · → [[lifecycles/roadmap-build-console]]
- **Repo Skills Catalog — committed Claude Code skills for operating ShopCX** · verified 2026-06-19 · → [[recipes/README]]
- **Roadmap Build Console — describe → spec → autonomous build → merge, all from the web app** · verified 2026-06-19 · → [[lifecycles/roadmap-build-console]]
- **Roadmap status accuracy — phase-consensus + live-job board status** · verified 2026-06-19 · → [[lifecycles/roadmap-build-console]]
- **Slack Home detail — make the App Home a destination, retire the List** · verified 2026-06-19 · → [[lifecycles/roadmap-build-console]]
- **Slack Roadmap Console — run the build console from Slack** · verified 2026-06-19 · → [[integrations/slack-roadmap-console]]
- **Slack Roadmap Home — mirror the board to the App Home tab (view + build, not messages)** · verified 2026-06-19 · → [[libraries/slack-home]]
- **Spec lifecycle + archival — verify → fold → archive → re-hydrate** · verified 2026-06-19 · → [[lifecycles/roadmap-build-console]]
- **Verification guides — "how to test this" on the spec detail page** · verified 2026-06-19 · → [[dashboard/roadmap]]
- **Worker self-update — the build box redeploys its own code when idle** · verified 2026-06-19 · → [[recipes/build-box-setup]]
- **Appstle pricing heal + migration monitor** · verified 2026-06-18 · → [[lifecycles/subscription-billing]]
- **Authoring chat grounding — give the Roadmap Opus chat live brain access** · verified 2026-06-18 · → [[lifecycles/roadmap-build-console]]
- **Blog → Posts + Product Resources (portal Resources + public storefront blog)** · verified 2026-06-18 · → [[lifecycles/blog-resources]]
- **Homepage rebuild — direct-response, Tabs-led** · verified 2026-06-18 · → [[recipes/edit-shopify-theme]]
- **Parallel builds (worktree-isolated, 5 lanes)** · verified 2026-06-18 · → [[recipes/build-box-setup]]
- **Shopify theme management via ShopCX (AI-driven, GitHub-commit)** · verified 2026-06-18 · → [[recipes/edit-shopify-theme]]
- **Storefront MVP — Amazing Coffee subscription funnel (internal subs · instrumentation · Meta CAPI · smart popup · checkout hardening)** · verified 2026-06-18 · → [[lifecycles/storefront-checkout]]
- **Storefront: survey chapter + converter-first PDP reorder** · verified 2026-06-18 · → [[lifecycles/storefront-checkout]]

## Related

[[project-management]] · [[dashboard/roadmap]] · [[lifecycles/roadmap-build-console]] · [[README]]
