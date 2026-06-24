# Spec status → 100% DB-driven (kill the status-commit deploys) ✅

**Owner:** [[../functions/platform]]
**Parent:** Platform mandate — the spec/board system stays fast + honest (continues the spec-card-db-companion lineage)
**Priority:** critical

## Problem

A spec markdown file conflates two different things:
- **Content** — the plan, phase *titles/descriptions*, verification steps, owner/parent. Durable, authored, deploy-worthy.
- **Status** — which phase is done (⏳/🚧/✅), deferred, priority(critical), blocked. High-frequency mutable runtime state.

Today status is encoded IN the markdown and every status change **commits to `main` → triggers a Vercel deploy.** There are **six** git-committing status writers (below) — a build flipping a phase ✅, an owner deferring, a priority toggle, the drift reconciler, Ada's supervision, the verification-green writeback. That's a deploy storm of pure metadata churn.

The fix: **status becomes 100% DB-driven.** The markdown holds only content; `spec_card_state` becomes the source of truth for status. The merge/PR is the status event; the feature-code git history is the durable proof a thing shipped. The file's existence (slug = filename) stays the spec's identity.

CEO-approved model + decisions (2026-06-24):
- Phase **titles** stay in markdown; phase **status** → DB.
- Authored metadata (owner, parent, blockedBy, autoBuild, repairSignature, summary) stays in markdown frontmatter; mutable status → DB.
- Add a lightweight **spec_status_history** audit (git gave us this for free; DB must replace it).
- The markdown file stays the spec's **identity**; the DB keys off slug.

## The boundary (what moves)

| Field | Today | Target |
|---|---|---|
| Phase status (planned/in_progress/shipped/rejected) | `⏳/🚧/✅/❌` emoji in markdown | DB `spec_card_state.phase_states[].status` |
| Overall status | derived from emojis (`deriveStatus`) | DB `spec_card_state.status` (rollup) |
| Deferred | `**Deferred:**` marker | DB `spec_card_state` (status='deferred' / flag) |
| Priority critical | `**Priority:** critical` marker | DB `spec_card_state.flags.critical` (or column) |
| Blocked | (unused markdown / transient flag) | DB `flags.blocked` (already) |
| Verification-bullet green | `✅` on `## Verification` bullets (spec-green-writeback) | DB (spec_test_runs / card flag) |
| **Title, plan, phase titles, owner, parent, blockedBy, autoBuild, repairSignature, summary** | markdown | **stays markdown** |

## Surface audit (every reader + writer)

### Readers — status from markdown today (→ must read DB)
- `src/lib/brain-roadmap.ts` — `parseSpec` (151-271), `deriveStatus` (107-126), `statusFromText` (82-88), `deriveSpecStatus` (566), `resolveBlockedBy` (279), `buildSpecCards` sort, `getFunctionMap` counts (411-441), `parseGoal`/`specCompletion` rollups (747-840, 667). The H1-emoji + phase-emoji + `**Deferred:**`/`**Priority:**` parsing all lives here.
- Board: `roadmap/page.tsx` (`effectiveStatus`, column bucketing, critical pip, phases), `roadmap/[slug]/page.tsx`, `map/page.tsx` (counts), `functions/[slug]/page.tsx`, `goals/page.tsx` + `goals/[slug]/page.tsx` (milestone status), `StatusControl`, `PriorityControl`, `PhaseList`, `BuildButton` (blockedBy gate).
- Build gate / chaining: `roadmap-actions.ts` (108-132) — reads first planned phase + `getSpecBlockers`.
- Crons/agents: `spec-test-cron.ts` (filters status==='shipped'), the box `builder-worker.ts` (`getSpec` for build context), `slack-roadmap.ts` (retired).

### Readers — status from DB today (the head start)
- `src/lib/spec-card-state.ts` — `getSpecCardStates`, `resolveBoardStatus`, `mergePhaseStates`, `deploymentState`, `rollupPhaseStatus`. The board already overlays these DB-first; the migration makes them DB-**only** and most collapse away.

### Writers — commit to markdown/git → DEPLOY (the six to eliminate)
1. `api/roadmap/status/route.ts` (111-116) — owner H1/phase emoji flip (Contents API PUT to main).
2. `api/roadmap/priority/route.ts` (141-146) — `**Priority:**`/`**Deferred:**` markers.
3. `api/roadmap/spec-drift/route.ts` (99-104) — owner one-tap phase ✅ flip.
4. `src/lib/spec-drift.ts` (369-374) — auto-reconcile phase ✅ flip on merge (via `applyMergedBuildEffects` in agent-jobs.ts:632).
5. `scripts/builder-worker.ts` (~2023) — Ada drift-supervise ✅ flip (`putFileMain`).
6. `src/lib/spec-green-writeback.ts` (108-114) — verification-bullet ✅ reflection.

All six PUT `docs/brain/specs/{slug}.md` on `branch:main` → bundle redeploy. **These are the deploy sources.**

### Writers — DB-only today (the pattern to standardize on)
`spec-card-state.ts` — `markSpecCardStatus`, `markSpecCardMergeShipped`, `markSpecCardBlocked`, `upsertCardState`. Callers: status route (122), spec-drift route (111), reconcile (384), `platform-director.ts` (598, 718), box init (2551), `agent-jobs.ts` merge hook (637-641).

## DB schema gaps (what's missing to be source-of-truth)
- `spec_card_state.status` CHECK lacks **`deferred`** (today deferred is markdown-only).
- No **`critical`** anywhere in the table (add column or `flags.critical`).
- No **audit trail** — add `spec_status_history (workspace_id, spec_slug, field, from, to, actor, reason, at)` (or extend `director_activity` with `action_kind='status_change'`).
- Deferred/critical **provenance** (who/when/why) — captured by the history table.

## Phases

## Phase 1 — DB authoritative for status (schema + backfill + reads) ✅
- Migration: add `deferred` to the status CHECK; add `critical` (+ `deferred`) to `spec_card_state`; create `spec_status_history`.
- Backfill: parse current markdown status for every spec → write `spec_card_state` (status, phase_states, critical, deferred). One-time.
- Flip every reader to **DB-only** for status: `brain-roadmap.parseSpec` parses CONTENT only (title, phase *titles*, owner, parent, blockedBy, autoBuild, repairSignature, summary) — stop deriving status/critical/deferred. Board + rollups + gate + box read status from `spec_card_state`. `resolveBoardStatus`/`mergePhaseStates` collapse to a plain DB read.

## Phase 2 — Writers go DB-only (the deploy kill) ✅
- Rewrite the six git-committing writers to write `spec_card_state` (+ `spec_status_history`) and **stop the markdown PUT**. Status/priority/drift/supervise/verification all become instant DB writes, zero deploys.
- `roadmap-actions` chaining + the build gate read phase status from the DB.

## Phase 3 — Strip status from markdown + simplify ✅
- One migration commit: strip phase emojis, `**Deferred:**`, `**Priority:** critical`, H1 status emoji from all spec markdown (phases become plain `## Phase N — title`). One deploy, then quiet.
- Delete now-dead code: `deriveStatus`, the spec `statusFromText`/marker regexes, `resolveBoardStatus`, `deploymentState`, `mergePhaseStates` forward-merge, the deploy-pending/SHA dance.

## Phase 4 — Repurpose spec-drift + docs ✅
- spec-drift shrinks to a light DB backstop ("did a merged build's phase get marked shipped in the DB?") — most of the markdown reconciler retires.
- Update brain docs: `project-management.md` ("markdown is the source of truth" → "content in markdown, status in DB"), `brain-roadmap.md`, `tables/spec_card_state.md`, fold this spec away.

## Verification
- On psql (pooler), run `\d public.spec_status_history` → expect the table to exist with columns `(id, workspace_id, spec_slug, field, phase_index, from_value, to_value, actor, reason, at)` and the two indexes `spec_status_history_slug_at` + `spec_status_history_field_at`.
- On the build box, run `npx tsx scripts/backfill-spec-status-from-markdown.ts` (dry run) → expect a list of per-workspace per-spec rows that would be upserted; pass `--apply` to write, then expect every spec in `docs/brain/specs/` to have a row in `spec_card_state` for the active workspace AND a `backfill` actor row per spec in `spec_status_history`.
- On `/dashboard/roadmap`, defer a spec via the PriorityControl (state="deferred") → expect the card moves to the **Deferred** column instantly AND `git log -1 docs/brain/specs/{slug}.md` shows no new commit on `main`. `select * from spec_status_history where spec_slug='{slug}' and field='deferred' order by at desc limit 1` → expect a `to_value='true'` row with `actor='owner:<uuid>'`.
- On `/dashboard/roadmap`, mark a spec critical via the PriorityControl → expect the **🔴 Critical** pip appears on the card instantly AND no markdown commit appears. `select * from spec_card_state where spec_slug='{slug}'` → expect `flags->>'critical'` is `'true'`.
- On `/dashboard/roadmap`, click an owner-only phase flip from ⏳ → ✅ via StatusControl → expect the phase pip flips on the board within ~1s, no `main` commit appears, and `spec_status_history` records a `field='status'` row with actor `owner:<uuid>`.
- On `/dashboard/control-tower`, one-tap-flip a surfaced spec-drift row → expect the row resolves, the spec card's status reflects the flip, and `spec_status_history` shows a row authored by `owner:<uuid>` with reason "spec-drift one-tap flip P{N} → ✅".
- Merge a `claude/*` build PR for any multi-phase spec → expect the phase flips to `shipped` in `spec_card_state`, the board card updates within seconds, the deploy chip shows `shipped · deploying` then `shipped · live` once the deploy lands, AND `spec_status_history` records the merge with `actor='merge:<sha>'`.
- Run `git log --oneline -200 docs/brain/specs/` from any day after this ships → expect only `spec:` content edits, `fold:` archives, and `build:` PRs — zero `roadmap:`, `spec-drift:`, or `spec-test: reflect ... green` status commits.
- Create a brand-new spec file with no `**Deferred:**` / `**Priority:**` / phase emojis → expect the board renders it as Planned (no DB row yet); after one flip the row appears with the expected status.
- On the build box, run `npx tsx scripts/strip-spec-status-markers.ts` (dry run) → expect a list of specs whose `# Title ⏳/🚧/✅`, `## Phase N — title ⏳/🚧/✅`, `**Deferred:**`, `**Priority:** critical`, and `## Verification` leading `✅` would be removed; pass `--apply` to commit the strip in one content-only deploy.
