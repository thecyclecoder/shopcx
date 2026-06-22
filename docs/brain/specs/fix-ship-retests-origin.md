# Proposed-Fix Ships → Auto-Re-test the Origin Spec ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[spec-test-agent]] + [[roadmap-build-console]]. Closes the loop on the propose-fix flow.

When a spec-test finds an issue, the owner clicks **Propose fix spec** → a fix spec is authored + built + ships. But the **originating spec's card keeps showing "Agent-tested · issues"** — because nothing re-tests the origin after the fix lands. The stale red badge makes a *resolved* issue look open (observed: `comp-subscriptions` showed ✗1 after `comp-transaction-type-constraint` (PR #181) shipped the fix). The owner shouldn't have to manually re-queue the origin's test.

## Model — link the fix to its origin, re-test on the fix's merge
- **Record the origin link.** When the propose-fix flow (`POST /api/roadmap/chat` `{action:"propose_fix"}`) seeds the fix spec, stamp a structured **`Fixes:`** metadata line in the fix spec — the **origin spec slug** + the **`check_key`(s)** it targets (the same hash [[spec-test-runs]] uses). Today the link is only prose ("fixes the shipped …"); make it machine-readable.
- **On the fix build's merge, re-enqueue the origin's spec-test.** Hook the merge path (`reconcileMergedJobs` / the same place [[spec-drift-agent]] stamps phases): if the merged build's spec has a `Fixes: {origin}` link, enqueue a `spec-test` for `{origin}` (deduped). The origin re-runs with the fix live → the previously-failing check flips ✅ → the "issues" badge clears automatically.
- **Tighten the badge.** A spec's "Agent-tested · issues" should reflect its **latest** run only (it already does) — so once the re-test passes, the card shows clean "Agent-tested" with no manual step. If the re-test still fails (fix didn't actually resolve it, or a migration wasn't applied), the badge stays red **correctly** — now a true signal, not a stale one.

## Guardrails
- Re-test only — never auto-marks the origin verified/archived (the owner's gate). It just refreshes the QC signal.
- Deduped + bounded: one re-test per origin per fix-merge; a fix with no `Fixes:` link does nothing (back-compatible).
- Evidence-honest: a still-failing re-test keeps the red badge — the loop surfaces truth, it doesn't paper over it.

## Verification
- Spec A's test fails check Y → Propose fix → fix spec B is authored with `Fixes: A (check <key>)` → B builds + merges → A's `spec-test` auto-enqueues → A re-runs → check Y passes → A's card shows clean "Agent-tested," no manual re-queue. (Re-validates the `comp-subscriptions` × `comp-transaction-type-constraint` case.)
- A fix that *doesn't* resolve the issue → A re-runs → check Y still fails → badge stays red (true signal).
- A normal build (no `Fixes:` link) merging → no origin re-test enqueued.

## Phase 1 — Fixes-link + re-test-on-merge ✅
Stamp `Fixes: {origin} ({check_keys})` in the propose-fix authoring brief/spec; on a build merge whose spec carries a `Fixes:` link, enqueue the origin's `spec-test` (deduped). Brain: [[../libraries/spec-test-runs]] · [[../libraries/agent-jobs]] (reconcileMergedJobs) · [[../dashboard/roadmap]] (human-queue propose-fix) · [[spec-drift-agent]] (shares the on-merge hook).

**Shipped:**
- `POST /api/roadmap/chat` `{action:"propose_fix"}` (`src/app/api/roadmap/chat/route.ts`) — the regression brief now (a) tags each failing check with its `[check {key}]` ([[../libraries/spec-test-runs]] `checkKey`) and (b) instructs the box to stamp a verbatim `**Fixes:** {origin} (check {key1}, {key2})` metadata line under the fix spec's `**Owner:** … · **Parent:** …` line.
- `parseFixesLink(raw)` + `fetchSpecRawFromMain(slug)` exported from `src/lib/spec-drift.ts` — strict parser (requires the `(check …)` parenthetical so a stray prose "Fixes:" can't false-positive); returns `{ origin, checkKeys }` or `null`.
- `retestOriginIfFixMerged(workspaceId, fixSlug)` in `src/lib/agent-jobs.ts`, called from `reconcileMergedJobs` inside the `pr.merged && j.kind === "build"` block (best-effort, own try/catch, independent of the spec-drift flip) — reads the merged fix spec from `main`, parses its `Fixes:` link, and re-enqueues the origin's `spec-test` via the shared `enqueueSpecTestIfDue` guard (origin's own shipped-but-not-archived gate + 20h/in-flight dedupe still apply). No link / self-reference → no-op (back-compatible).
