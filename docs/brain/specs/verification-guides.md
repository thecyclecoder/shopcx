# Verification guides — "how to test this" on the spec detail page ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

The [[spec-lifecycle-and-archival|verify gate]] asks the owner to confirm a shipped feature works in prod before archiving — but **shipped specs don't say HOW to test them**, so the owner is stuck ("it's shipped, but I don't know what to click to verify it"). Give every spec a concrete **Verification** section ("go to X → do Y → expect Z"), authored by the build that ships it, rendered prominently on the detail page right next to **Mark verified & archive** — and generatable retroactively for the backlog of already-shipped specs.

**Business outcome:** the owner can actually *verify* shipped work (then archive it) instead of leaving it parked in Shipped forever because the test path is unknown.

## Phase 1 — Convention + the build authors it ✅
- ✅ Added a `## Verification` section to the spec template ([[../project-management]] § Writing a spec): a short, **concrete, prod-facing checklist** — exact route/Slack action/CLI, the input, and the **observable expected result** (e.g. "On `/dashboard/roadmap/box`, queue a build → that lane shows the slug + elapsed"). No vague "test it works." The authoring chat's `BASE_SYSTEM` ([[roadmap-build-console]], `src/app/api/roadmap/chat/route.ts`) now lists it among "a good spec has," so new specs include it.
- ✅ `build-spec` skill: a new step 5 says to **write the `## Verification` section** on completion from what it actually built (the real routes/tables/actions it touched). So newly-shipped specs arrive test-ready.

## Phase 2 — Render it on the detail page ✅
- ✅ `/dashboard/roadmap/[slug]` (`src/app/dashboard/roadmap/[slug]/page.tsx`): `extractSpecSection`/`stripSpecSection` ([[../libraries/brain-roadmap|src/lib/brain-roadmap.ts]]) pull the `## Verification` block out of the spec markdown; it renders as a **distinct, prominent card** (`VerificationCard.tsx`, teal "✅ How to verify in prod" checklist) positioned right under `BuildButton.tsx` / **Mark verified & archive** — the test steps sit where the verify decision happens. Stripped from the article body so it isn't shown twice.
- ✅ If a spec has no `## Verification` section, the card shows a **"No test plan yet"** state with an owner-only **Generate test plan** button instead of silence.

## Phase 3 — Retroactive generation (the backlog) ✅
- ✅ Owner-only **Generate test plan** button (in `VerificationCard.tsx`) on any spec lacking `## Verification`. It calls `POST /api/roadmap/chat` with `action:"generate_verification"`, which seeds Opus (brain-grounded, with `read_brain_page`/`grep_repo`) with the spec, drafts a concrete `## Verification` section, and **commits it to `specs/{slug}.md` on main** (same GitHub-commit path as the authoring chat). The new section appears after the next deploy.
- ✅ Reuses the existing chat/`POST /api/roadmap/chat` infra — no new LLM surface (just a new `action`).

## Phase 4 — Backfill the current shipped backlog (one pass) ✅
- ✅ **Single batched backfill, done in this PR:** every spec currently `✅` shipped in `specs/` without a `## Verification` section got one authored (by the build agent — the Phase 3 Opus authoring path, run inline). The 10 shipped specs — `authoring-chat-persistence`, `build-approval-gates`, `build-box-status-view`, `build-lifecycle-hardening`, `fold-build-batching`, `goal-decomposition-engine`, `killer-statics`, `roadmap-build-console`, `slack-roadmap-console…`, `spec-lifecycle-and-archival` — are now verifiable immediately, no per-spec clicking.
- ⏳ Already-archived features (spec deleted) getting a guide appended to their brain home page is **deferred** — it's outside the completion criteria (which scope the backfill to shipped specs in `specs/`), and the archived brain pages are product surfaces whose concrete prod steps shouldn't be guessed. Follow-up: extend `generate_verification` with a brain-page-target path + surface it from the board's Archived section.

## Safety / invariants
- Verification steps must be **concrete + reproducible by a human** (route + action + expected result), never "verify it works."
- The spec markdown stays source of truth; the section lives there (folds into the brain on archive like the rest).
- Generation is **owner-gated** and commits to a `claude/*` branch or `main` via the existing authoring path (no new write surface).

## Completion criteria
- New specs ship with a concrete `## Verification` section (the build writes it).
- The detail page renders it as a prominent card beside **Mark verified & archive**.
- A shipped spec with no test plan offers **Generate test plan** → produces concrete, followable steps.
- **The existing shipped backlog is backfilled in one pass** — every currently-shipped spec has a `## Verification` section after this lands.

## Verification
- Open `/dashboard/roadmap/{a-spec-with-a-Verification-section}` (e.g. this one, or any backfilled shipped spec) → expect a teal **"✅ How to verify in prod"** card in the sidebar right under the build/verify buttons, rendering the checklist — and the same section **not** duplicated in the article body.
- Open a spec that has **no** `## Verification` section → expect a dashed **"No test plan yet"** card; as the owner expect a **Generate test plan** button (non-owners see no button).
- Tap **Generate test plan** → expect a "Generated — committed to `specs/{slug}.md`" confirmation; after the next deploy the spec's detail page renders the new checklist card.
- Confirm the backfill: every spec file in `docs/brain/specs/` that is `✅` shipped now contains a `## Verification` heading (`grep -L '## Verification' docs/brain/specs/*.md` lists none of the shipped ones).
- Author/build a brand-new spec → expect it to arrive with a `## Verification` section (the authoring chat + `build-spec` skill write it).

## Related
[[spec-lifecycle-and-archival]] · [[roadmap-build-console]] · [[../dashboard/roadmap]] · [[../project-management]] · [[build-lifecycle-hardening]]
