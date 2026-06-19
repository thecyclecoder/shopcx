# Verification guides — "how to test this" on the spec detail page ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

The [[spec-lifecycle-and-archival|verify gate]] asks the owner to confirm a shipped feature works in prod before archiving — but **shipped specs don't say HOW to test them**, so the owner is stuck ("it's shipped, but I don't know what to click to verify it"). Give every spec a concrete **Verification** section ("go to X → do Y → expect Z"), authored by the build that ships it, rendered prominently on the detail page right next to **Mark verified & archive** — and generatable retroactively for the backlog of already-shipped specs.

**Business outcome:** the owner can actually *verify* shipped work (then archive it) instead of leaving it parked in Shipped forever because the test path is unknown.

## Phase 1 — Convention + the build authors it ⏳
- ⏳ Add a `## Verification` section to the spec template ([[../project-management]] § Writing a spec): a short, **concrete, prod-facing checklist** — exact route/Slack action/CLI, the input, and the **observable expected result** (e.g. "On `/dashboard/roadmap/box`, expect 5 build + 1 fold lane; queue a build → that lane shows the slug + elapsed"). No vague "test it works."
- ⏳ `build-spec` skill: on completion, **write the `## Verification` section** from what it actually built (it knows the routes/tables/actions it touched). So newly-shipped specs arrive test-ready.

## Phase 2 — Render it on the detail page ⏳
- ⏳ `/dashboard/roadmap/[slug]` (`src/app/dashboard/roadmap/[slug]/page.tsx`): pull the `## Verification` block out of the spec markdown and render it as a **distinct, prominent card** (checklist styling) positioned next to **Mark verified & archive** in `BuildButton.tsx` — so the test steps are right where the verify decision happens.
- ⏳ If a spec has no `## Verification` section, show a **"No test plan yet — Generate"** affordance instead of silence.

## Phase 3 — Retroactive generation (the backlog) ⏳
- ⏳ Owner-only **"Generate test plan"** button on any spec lacking `## Verification`. It seeds the Opus authoring path ([[roadmap-build-console]] chat, brain-grounded) with the spec + its **folded brain homes** (lifecycles/dashboards/tables it references) + recent code, and produces a concrete `## Verification` section → commits it to `specs/{slug}.md` (same GitHub-commit path as the authoring chat). For already-archived specs, generate the guide against the current brain page instead.
- ⏳ Reuses the existing chat/`POST /api/roadmap/chat` infra — no new LLM surface.

## Phase 4 — Backfill the current shipped backlog (one pass) ⏳
- ⏳ When this ships, run a **single batched backfill**: for every spec currently `✅` shipped in `specs/` **without** a `## Verification` section, generate one (the Phase 3 path, looped) → **one PR** adds test plans across the whole backlog. So the existing shipped specs (e.g. `build-approval-gates`, `roadmap-build-console`, `killer-statics`, `fold-build-batching`, `parallel-builds`, `worker-self-update`, …) become verifiable **immediately, with no per-spec clicking**.
- ⏳ Already-archived features (spec deleted) get a guide appended to their brain home page instead, surfaced from the Archived section.

## Safety / invariants
- Verification steps must be **concrete + reproducible by a human** (route + action + expected result), never "verify it works."
- The spec markdown stays source of truth; the section lives there (folds into the brain on archive like the rest).
- Generation is **owner-gated** and commits to a `claude/*` branch or `main` via the existing authoring path (no new write surface).

## Completion criteria
- New specs ship with a concrete `## Verification` section (the build writes it).
- The detail page renders it as a prominent card beside **Mark verified & archive**.
- A shipped spec with no test plan offers **Generate test plan** → produces concrete, followable steps.
- **The existing shipped backlog is backfilled in one pass** — every currently-shipped spec has a `## Verification` section after this lands.

## Related
[[spec-lifecycle-and-archival]] · [[roadmap-build-console]] · [[../dashboard/roadmap]] · [[../project-management]] · [[build-lifecycle-hardening]]
