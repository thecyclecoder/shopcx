# Project management via the brain

The brain isn't just reference docs — it's also where we plan + track work. This page explains how features move from idea → spec → in-progress → shipped, and where each state lives.

## The org tiers — CEO → Directors → Agents

Three layers, mapping exactly to the supervisable-autonomy north star ([[operational-rules]] § North star) — *CEO sets objectives → role agent holds + supervises → tools execute, each loop slower and wiser than the one below*:

- **CEO** — owns company objectives (goals/BHAGs), prioritizes under constraints, arbitrates across functions, grades + coaches the directors ([[tables/director_decision_grades]]). You today → an autonomous CEO agent. The "CEO mode" ([[goals/ceo-mode]]).
- **Directors — the executive team (the C-suite).** One per **function** ([[functions/]]), each a permanent domain owner with mandates, supervising its agents and reporting to the CEO. *Director = executive, not middle management.* The **business directors** (Growth/CMO/Retention/CFO/Logistics/CS) **run** the Superfoods business; the **Platform/Engineering director (Ada, the CTO seat)** **builds** ShopCX-as-software. They are **peers** — the build-vs-business split is a lens, not a rank. Platform is the keystone (the build engine every other director ships through) but still a peer; the CEO arbitrates.
- **Agents** — the bounded autonomous tools each director owns + grades + coaches (the `agent_jobs.kind`s: Bo/build, Rafa/repair … under Platform; the storefront-optimizer … under Growth). An agent optimizes a *bounded proxy*; its director owns the *objective* and supervises it. **(Naming: "agent" is the canonical org-tier term. "Worker" / "tool" are synonyms — and `worker` persists as the internal code/table identifier, e.g. `agent_jobs.kind`, `agent_action_grades`, `coachAgent`. Same thing, one tier.)** Every new agent kind ships to the [[operational-rules#PM-agent activation contract|PM-agent activation contract]] — REACTIVE + GATED + BACKSTOP through one `enqueueXIfDue` chokepoint — so a queue-consuming worker is only considered complete when all three legs are in place.

## The work hierarchy — no orphan specs

Every spec belongs to something bigger; the parent chain terminates at the org chart.

```
Function (Growth, CMO, Retention, CFO, Logistics, CS, Platform/Eng)   functions/{slug}.md — permanent owner
  ├─ Mandate  (perpetual charter, metric-tracked, never "done")
  │     └─ Spec → Phase → Build
  └─ Goal     (finite BHAG, rolls up to 100% then closes)   goals/{slug}.md
        └─ Milestone
              └─ Spec → Phase → Build
```

- **Functions** (`docs/brain/functions/`) are the **permanent skeleton** — one per org-chart director. Each owns perpetual mandates and the specs/goals under them. A function doc doubles as the CEO-mode director-agent's charter ([[goals/ceo-mode]]).
- **Two kinds of parent.** A **mandate** is *perpetual* — a standing charter a function owns forever (e.g. Growth's "static-ad optimization"); it never finishes, is measured by a metric trend, and keeps emitting specs. A **goal** (`docs/brain/goals/`) is *finite* — it has a finish line, decomposes into milestones, and closes at 100%. Don't model a perpetual charter as a goal.
- **Every spec declares an `owner` + `parent`.** Owner = exactly one function (the DRI — single-threaded ownership, even for shared work, with optional "contributes-to" links). Parent = a function mandate or a goal milestone. A metadata line under the spec's H1: `**Owner:** [[../functions/{slug}]] · **Parent:** {mandate or goal-milestone}`.
- **A parent is NEVER another spec (no-spec-parent).** Even a *fix-spec* (repair / db-health / security / regression / coverage) parents to a **function mandate** — most self-healing fixes are reliability work → `[[../functions/platform]] — Infra & DevOps / reliability mandate`. When a fix genuinely references the spec it's fixing, that pointer goes on the **`related_spec`** column (a link), not the parent. The authoring chokepoint ([[libraries/author-spec]] `assertValidParent`) THROWS `InvalidParentError` on a `../specs/` parent (or a bare goal/function, or free-text), so a fix-spec can't loop forever in Vale's review anymore.
- **Optional `Blocked-by` — build prerequisites** ([[specs/spec-blockers]]). A spec that depends on another spec shipping first adds a header line `**Blocked-by:** [[spec-a]], [[spec-b]]` (parsed like Owner/Parent, [[libraries/brain-roadmap]] `parseSpec`). A blocker is **cleared** once its spec ships (or is archived/folded); until then the build enqueue chokepoint (`queueRoadmapBuild`, [[libraries/roadmap-actions]]) **refuses to queue a build** for the dependent spec and the [[dashboard/roadmap|board]] shows a "🔒 Blocked by …" chip with the Build button disabled. This formalizes the manual "queue after X merges" chaining and stops two builds colliding on the same files. Pointing `Blocked-by` at an already-shipped/archived spec is a no-op (treated as cleared). **When the *last* blocker ships, the dependent's build auto-queues itself** (`agent-jobs.autoQueueUnblockedBy`, fired from `reconcileMergedJobs` — the same merge/board-load hook spec-test uses): merge the prerequisite and the chained build fires hands-off, de-duped to one auto-queue per spec. To keep a spec manual-only, add `**Auto-build:** off` under its H1 (the auto-queue skips it; the manual Build button still works).
- **No orphans.** A spec with no owner/parent is incomplete. The [[specs/goal-decomposition-engine|goal-decomposition engine]] enforces this when the planner proposes specs; a board lint flags any existing orphan. Worked example: [[functions/growth]] owns [[specs/winning-static-creative-finder]] under its static-ad mandate.

This hierarchy is operationalized by the [[specs/goal-decomposition-engine|goal-decomposition engine]]: write a goal (or point at a mandate), the planner gap-analyzes against the brain and proposes owner/parent-tagged specs, you approve the branches, and the existing build pipeline ships them.

## The five states

```
   ┌──────────┐   ┌──────────┐   ┌──────────────┐   ┌──────────┐   ┌──────────┐
   │  IDEA    │ → │ PLANNED  │ → │  IN TESTING  │ → │ SHIPPED  │ → │  FOLDED  │
   │ (memory) │   │ authored │   │ built+green  │   │ on main  │   │ folded + │
   │          │   │ +Vale    │   │ ON A BRANCH  │   │ (atomic) │   │ archived │
   │          │   │  all ⏳  │   │ phases build │   │  (✅)    │   │ spec rm  │
   │          │   │          │   │ _sha'd, not  │   │          │   │          │
   │          │   │          │   │ yet promoted │   │          │   │          │
   └──────────┘   └──────────┘   └──────────────┘   └──────────┘   └──────────┘
```

Status flow: `planned → in_testing → shipped → folded`. `in_testing` is the branch-accumulation state — built + tested on a branch, **not yet on `main`** ([[lifecycles/spec-goal-branch-pm-flow]]). "In progress" is the *phase*-level mid-state (some phases built, some still ⏳); the *whole-spec* board status reads `in_testing` once every phase is built + the branch preview is green.

| State | Where it lives | How you change it |
|---|---|---|
| **Idea** | An informal note in agent memory or a chat — not yet committed | Author a spec to `public.specs` to promote it |
| **Planned** | A `public.specs` row, `status='planned'` (or `in_review` until Vale passes), every phase `planned` | Author the spec; Vale stamps `vale_pass`; the build pipeline picks it up |
| **In testing** | Every phase carries a `spec_phases.build_sha` (built on its `claude/build-{slug}` branch) and the branch preview's spec-test + security are green — **built but NOT on `main`**. Derived ([[libraries/brain-roadmap]] `applyInTestingOverlay`), gated by [[libraries/agent-jobs]] `isSpecPromoteEligible`. *Markdown is content-only.* | The build pipeline accumulates phases on the spec branch + runs the pre-merge tests; no status writer needed (derived) |
| **Shipped** | Promoted to `main` and live. A **one-off spec** auto-merges its branch (Gate A); a **goal-bound spec** ships only when its whole goal lands atomically (Gate C). Stays unfolded (the "Shipped — awaiting fold" column) until its machine spec-test passes. | The promotion stamps the phases `shipped` (`applyMergedBuildEffects` one-off / `applyGoalPromotionEffects` goal); [[tables/spec_status_history]] audits who/when/why |
| **Folded** | Spec content folded into the relevant `lifecycles/`/`tables/`/`libraries/`/`inngest/`/`integrations/`/`recipes/`/`dashboard/` pages, a one-line entry appended to [[archive]], the spec row **preserved** with `status='folded'`. The "Status / open work" block on the lifecycle reads `Shipped:`. | **MACHINE spec-test pass** (agent-verdict `approved`, no open regression) → auto fold-build → merge. Human QA is advisory and never gates this. |

### Re-authoring a dismissed/reviewed spec RE-OPENS it

**re-author-re-opens-dismissed invariant.** A freshly-authored spec lands `in_review`; Vale stamps `vale_pass` + `vale_review_passed_at`, Ada disposes (planned/deferred) or DISMISSES it (a standing `init_dismissed`/`groomed_dismissed` row in [[tables/director_activity]] whose `metadata.init_key`/`groom_key` the init/groom lanes scan to SKIP the spec forever — the row IS the dedup). If such a spec is later CORRECTED by a re-author but those stale signals stay, the corrected content sits DEAD under the old verdict (the `migration-pricing-preserved-base-above-msrp` gap: status derived planned, stale Vale stamp, dismissal still in effect, `auto_build=false`). So: **re-authoring an EXISTING spec whose content CHANGED (title/summary/any phase title·body·verification differs) RE-OPENS it** — [[libraries/author-spec]] `reopenIfReauthoredAndChanged` resets the review signals (`vale_pass`/`vale_review_passed_at`/`ada_disposition`/`intended_status`) + flips to `in_review` (Vale re-reviews the NEW content, Ada re-disposes) AND clears the dismissal ledger ([[libraries/director-activity]] `clearDirectorSpecDismissals` → a `spec_reopened_after_reauthor` audit row). A NO-OP re-author (identical content) does NOT churn Vale. Same class as the orphan-park fixes — a corrected-after-rejection spec must never silently stay dead.

### Where status lives — DB, not markdown

**spec-status-db-driven** ([[specs/spec-status-db-driven]], 2026-06-24): the markdown is **content-only** (title, phase titles, owner, parent, blockedBy, autoBuild, repairSignature, summary, verification). **Status / per-phase status / critical / deferred live in [[tables/specs]] and [[tables/spec_card_state]] authoritatively**, with an audit row per transition in [[tables/spec_status_history]]. The board reads the DB. Every status writer (owner flip, build merge, drift reconciler, Ada drift-supervise, priority/defer, fold worker) writes the DB only — zero markdown commits, zero deploys. The phase emojis you may still see in older specs are legacy noise; the DB rows win.

### Shipped vs Folded — the fold fires on the machine spec-test pass

**Shipped (✅)** = the build pipeline ran and deployed the code — *automated*. **Folded** = the spec's machine spec-test passed, so its durable knowledge has been extracted into the permanent brain pages and its [[tables/specs]] row flipped to `status='folded'` — also *automated*. **The fold trigger is the MACHINE spec-test pass, NOT a human click** ([[specs/fold-on-spec-test-pass]]). The gap between Shipped and Folded should be a short, honest "live but not yet machine-tested-green" list, not a graveyard of done work waiting on an uncompletable human-QA backlog. Fold is **non-destructive**: the [[tables/specs]] / [[tables/spec_phases]] row is **preserved** with `status='folded'` and every original column intact (title, summary, owner, parent, blocked_by, milestone_id) — the fold only extracts knowledge into the brain pages, creates an `archive.d/{slug}.md` pointer line, and updates the row's `status` + `updated_at`. **Nothing is ever lost; the DB row is the permanent archive.**

**Human QA is advisory, never a gate** ([[tables/spec_test_human_checks]]). A bullet the box QA agent can't auto-test (visual/UX or prod-mutating) is flagged **👤 needs-human** and surfaced on the **Human QA (optional)** queue — a place to run extra human checks if you want. It **never** blocks the fold, the brain, or the spec's progression; the owner can clear an item whenever (or never). Why machine-pass is sufficient: fold is non-destructive (a fold you'd want to undo is just a follow-up spec), so the per-phase `## Verification` checks graded green by the spec-test agent are enough verification to extract the knowledge.

**The machine spec-test** ([[specs/spec-test-agent]]). A box QA agent runs each shipped-but-unfolded spec's `## Verification` checklist for the *automatable* bullets — non-destructive checks only (repo/`tsc`, GitHub CI, Vercel deploy/logs/env, read-only DB probes, GET endpoints, owner-authed read-only browser checks, internal-only sandbox flows) — and records a [[tables/spec_test_runs]] row with a distinct **"Agent-tested ✅ / ⚠️ issues"** stamp (`agent_verdict`). An **`approved`** verdict (every automatable bullet green, no open regression) **auto-folds** the spec via the existing fold-enqueue path (Gate B, [[libraries/spec-test-runs]] `autoFoldVerifiedSpecs`) — no owner click. A **failing** verdict (`issues`/`needs_human`/`error`, or any open auto-`fail`) does NOT fold — it surfaces the failure as a regression for review. Surfaced on the [[dashboard/roadmap|Developer → Spec Tests]] page, the board card chip, and the spec's VerificationCard. The owner can still **Fold to brain now** manually as an override. See the supervisable-autonomy north star in [[operational-rules]].

To revisit an archived feature, don't reactivate the stale spec — use **New spec from brain** (re-hydration): the authoring chat seeds Opus with the *current* brain page and drafts a *fresh* spec to extend or fix it. See [[dashboard/roadmap]] + [[lifecycles/roadmap-build-console]].

## Writing a spec

Author a spec through the DB via [[libraries/author-spec]] `authorSpecRowStructured` — the STRUCTURED authoring path ([[specs/pm-structured-intent-and-refs]]). The `public.specs` row + `public.spec_phases` rows + `spec_phase_checks` rows + `spec_brain_refs` rows ARE the spec; there is no `docs/brain/specs/*.md` on disk anymore. Structured input shape:

```ts
authorSpecRowStructured(workspaceId, {
  slug, title,
  owner: "{function_slug}",              // Owner: exactly one function DRI
  parent: "{prose label}",               // legacy prose label (for display only)
  // TYPED parent — the DB-authoritative fields (pm-structured-intent-and-refs Phase 2):
  parentKind: "function" | "mandate" | "milestone",
  parentRef:  "{function_slug}" | "{function_slug}#{mandate_slug}" | "{milestone_uuid}",
  why:  "plain-language why this spec exists (shared human + agent intent — required)",
  what: "plain-language what changes when this ships (required)",
  summary: "one-paragraph outcome-tied summary",
  blocked_by: [ "{prerequisite-slug}" ],  // optional
  phases: [
    {
      title: "phase name",
      why:  "plain-language why this phase exists",
      what: "plain-language what changes when this phase ships",
      body: "concrete work: file paths, schema, tasks",
      checks: [
        { position: 1, kind: "auto"  as const, description: "On {where}, {do what} → expect {observable result}." },
        { position: 2, kind: "human" as const, description: "..." },
      ],
    },
  ],
  brainRefs: [                            // 0-4 rows, each brain_slug is a real docs/brain/*.md
    { brain_slug: "libraries/foo" },
    { brain_slug: "tables/bar" },
  ],
})
```

The author chokepoint HARD-gates on non-empty `why`+`what` at every level and ≥1 check per phase (`MissingIntentError` / `MissingChecksError`), so a spec that would render as unreadable / untestable never lands in the DB. Phase status lives in [[tables/spec_phases]] (DB); the roadmap board reads it live, no deploy needed.

**`Brain refs:` — accuracy-first brain scoping ([[specs/pm-structured-intent-and-refs]] Phase 2).** Brain refs are stored as `spec_brain_refs` RELATION rows (spec_id/phase_id → `brain_slug`) — 2-4 pages per spec — NOT a `**Brain refs:**` prose line. The [[../.claude/skills/build-spec|build-spec]] skill Reads each authored `docs/brain/{brain_slug}.md` FIRST, before any grep or `docs/brain/README.md` sweep, as the authoritative context for the build (falling back to grep/README only if they're insufficient). `scripts/_check-brain-refs.ts` fails CI on a dangling slug. Frame this as an ACCURACY improvement: the builder Reads the RIGHT pages instead of missing one or reading three wrong ones; the context trim is a modest bonus.

**`Brain refs:` are SUGGESTED at authoring time ([[libraries/brain-ref-suggest]]).** So authors don't hand-pick refs, [[libraries/author-spec]] scans the body for the `src/lib/…` files, `public.…` tables, and existing brain wikilinks it names, resolves each to a `docs/brain/{libraries|inngest|tables|lifecycles|…}/{name}.md` that ACTUALLY exists on disk, and persists the top ≤4 as `spec_brain_refs` rows via `replaceSpecBrainRefs`. **Never a dangling ref:** each candidate is verified against the current `docs/brain/` tree before the row lands. Nothing mappable → no rows (the builder falls back to grep-the-brain). Author-confirmable: a subsequent structured author replaces the row set with the author's own picks.

**Phases ACCUMULATE on one spec branch → the spec ships ATOMICALLY (spec-goal-branch-pm-flow M1–M5).** A spec's phases build one-by-one onto ONE persistent branch `claude/build-{slug}` (phase per commit, `Spec:`/`Phase:` trailers). A built phase is stamped `spec_phases.build_sha` and stays `in_progress` (NOT shipped) — `shipped` is reserved for the atomic promotion. The accumulation gate ([[libraries/specs-table]] `isSpecAccumulationComplete`) blocks promotion until EVERY phase is built on the branch. Then:

- **One-off spec** (no goal) → its `claude/build-{slug}` branch merges to `main` directly (Gate A, [[libraries/github-pr-resolve]] `autoMergeReadyPrs` — but ONLY for one-off specs; a goal-bound branch is handed off). `applyMergedBuildEffects` stamps every phase `shipped` with the merge PR # + SHA.
- **Goal-bound spec** (has a `milestone_id → goal`) → its branch merges into the goal branch `goal/{goal-slug}` (Gate B / M4, `promoteEligibleSpecsToGoalBranch`, sequenced by `blocked_by`), and the WHOLE goal lands on `main` in ONE atomic merge (Gate C / M5, `promoteCompleteGoalsToMain`) once every member spec is on the goal branch and green. `applyGoalPromotionEffects` is the **only shipped-writer** for goal-bound specs — it stamps every member phase `shipped` with the single goal→main merge SHA.

Provenance is tagged per-phase on `spec_phases.{pr,merge_sha}` ([[specs/spec-status-phase-pr-provenance]]) at the PROMOTION (a built-but-unpromoted phase carries only `build_sha` and reads `in_progress`), so "shipped" is provable/auditable; the board renders a `P2 ✓` link per shipped phase. Promote-eligibility = accumulation-complete ∧ spec-test-green (on the branch preview) ∧ security-green ([[libraries/agent-jobs]] `isSpecPromoteEligible`). Ada (director, grooming/escort) treats a spec with ≥1 **branch-built** phase (`build_sha`, NOT a `pr` tag) as **started** and sequences the next phase's build off the branch — branch-build, never main-merge. The full end-to-end trace — spec branch → goal branch → atomic main promotion, the three gates, and Reva's escalate-not-revert atomic deploy-watch — is in [[lifecycles/spec-goal-branch-pm-flow]].

The **`## Verification` section** is the "how do I test this?" checklist ([[specs/verification-guides]]). The build that ships a spec **writes it** from the routes/tables/actions it actually touched, so a shipped spec arrives test-ready — and it's exactly what the **machine spec-test** grades: an `approved` run over these bullets auto-folds the spec. The spec detail page renders it as a prominent card with the per-bullet agent verdicts + the advisory **Fold to brain now** override. A shipped spec missing the section offers an owner-only **Generate test plan** button (Opus drafts one, brain-grounded). It folds into the brain with the rest of the spec on fold.

**Structured intent + structured verification checks ([[specs/pm-structured-intent-and-refs]]).** Every level of the PM tree (goals, goal_milestones, specs, spec_phases) carries plain-language `why` + `what` columns that LEAD the detail page — the same value humans and agents both read. Specs + phases are HARD-gated: [[libraries/author-spec]] `authorSpecRowStructured` throws `MissingIntentError` before the DB write when either is empty (or fails the plain-language lint that rejects code fences / `file:line` / `**Header:**` lines). The `## Verification` bullets are also stored as structured rows in [[tables/spec_phase_checks]] (`{position, description, kind:'auto'|'human'}`); the same chokepoint gates ≥1 check per phase (`assertEveryPhaseHasChecks`). Brain refs move off the prose `**Brain refs:**` line into [[tables/spec_brain_refs]] rows (spec_id/phase_id → `kind/name` slug) — `scripts/_check-brain-refs.ts` validates every slug resolves to a real `docs/brain/{kind}/{name}.md`. The typed parent lives on `specs.parent_kind` (`function`/`mandate`/`milestone`) + `specs.parent_ref`. Legacy rows keep working (columns nullable); new authoring is gated.

## Kicking off a build session

Once the spec is in `specs/`, start a new Claude Code session and fire:

```
/goal do everything in docs/brain/specs/{slug}.md
```

The session reads the spec and executes ONE phase per session, committing it onto the spec's persistent `claude/build-{slug}` branch ([[lifecycles/spec-goal-branch-pm-flow]]). It does NOT edit phase emojis — status is DB-driven ([[tables/spec_phases]]): a committed phase is stamped `build_sha` (`stampPhaseBuilt`) and reads `in_progress` (built, not shipped) until the spec is promoted to `main`. The next phase builds atop the prior phase's commit on the same branch — no per-phase PR to `main`, no `main` round-trip between phases. (In the autonomous box, "Build all" chains the phases automatically.)

## Folding a shipped spec into the brain (on machine spec-test pass)

This is the **Folded** transition — `shipped → folded + archive-index`. **It fires automatically the moment the spec's MACHINE spec-test passes** (agent-verdict `approved` + no open regression → Gate B `autoFoldVerifiedSpecs` enqueues a fold-build; see [[libraries/spec-test-runs]]). No human click is required — human QA is advisory and never gates it. The owner can still trigger the same fold-build manually via **Fold to brain now** as an override. When all phases hit ✅, the completion criteria are met, AND the machine spec-test is `approved`:

### The fold-to-brain infrastructure

The fold process is now **fully DB-driven** ([[specs/spec-fold-from-db-row]]): the fold-to-brain skill reads each spec's body from `public.specs` + `public.spec_phases` via [[libraries/specs-table]] `getSpec(workspaceId, slug)`, not from the on-disk markdown. The box worker materializes each shipped spec as an in-memory text rendering (H1 + Owner/Parent/Blocked-by header + `## Phase N` blocks + concatenated `## Verification` sections — identical shape to the old markdown). The fold-agent operates on this in-memory text and produces brain page edits exactly as before, then **preserves the spec row with `status='folded'`** (not deleted). The only markdown file operation is `git rm docs/brain/specs/{slug}.md` where the legacy file exists (a no-op for newly-authored specs that never had a `.md` post [[specs/spec-readers-from-db-retire-parser]]). After the fold commits succeed, the worker flips the row: `UPDATE public.specs SET status='folded', updated_at=now() WHERE id=$1`. The row preservation is load-bearing: the board's archive view + audit history render the folded spec card unchanged; the `updated_at` timestamp becomes the verified date shown in the archive.

### Fold steps

When all phases hit ✅, the completion criteria are met, AND the machine spec-test is `approved`:

1. **Fold the content into existing brain pages** — every concept the spec introduced gets a permanent home:
   - New tables → `tables/{name}.md`
   - New Inngest functions → `inngest/{name}.md`
   - New library files → `libraries/{name}.md`
   - New external API → `integrations/{name}.md`
   - End-to-end flow → `lifecycles/{name}.md` with a "Status / open work" section reading `Shipped: ...`
   - Common operational moves → `recipes/{name}.md`
   - Dashboard surfaces → `dashboard/{route}.md`
   - Cross-cutting rules → `customer-voice.md` / `operational-rules.md` / `ui-conventions.md` / `orchestrator-tools.md`
2. **Cross-link** — every new page wikilinks 3-5 related pages and is wikilinked FROM at least one existing page (so the brain stays navigable).
3. **Update the README** — `README.md` folder counts + the Core/Tickets/AI/etc. category lists if any table moved into them.
4. **Append to the archive index** — add one line to `docs/brain/archive.d/{slug}.md` with EXACTLY ONE line: `- **{Title}** · verified {YYYY-MM-DD} · → [[lifecycles/{slug}]]` (the `· verified {date} ·` token is the format the board parses — keep it literal). The board reads folded specs directly from the [[tables/specs]] rows where `status='folded'` and uses the preserved `updated_at` as the verified date; `archive.d/` is a backup surface for git history.
5. **Flip the row to `folded` (preserved, NOT deleted)** — the [[tables/specs]] row keeps its history with `status='folded'`; every column (title, summary, owner, parent, blocked_by, milestone_id) is preserved so the board's archive view + audit history render the card unchanged. The fold-build PR also `git rm`s the on-disk `docs/brain/specs/{slug}.md` where it exists (a no-op for newly-authored specs) — this is non-destructive: the row is preserved and the markdown is always `git show`-recoverable.
6. **One PR / commit** — fold + archive.d entry + status-flip + commit together. Don't leave the spec lingering "just in case." Git history is the immutable archive.

## The "Status / open work" pattern on lifecycle pages

Every `lifecycles/*.md` page ends with this block before the Related section:

```markdown
## Status / open work

**Shipped:** {one-sentence summary of the happy path that's actually
end-to-end wired}

**Known gaps / not yet shipped:**
- {bullet} {evidence — file path or comment}

**Recent activity:**
- {hash} {commit subject — last 1-3 commits touching this area}

**Open questions:** {bullets, or "None"}
```

This is where "current state" lives for SHIPPED features. The spec format covers PLANNED features. Together they answer:

- "Is X built?" → check the lifecycle's Status block
- "Is X planned but not built?" → look in `specs/`
- "Is X being worked on right now?" → spec phase emoji + recent commits in Status block

## Memory vs brain

| Use memory for | Use brain for |
|---|---|
| Dylan's preferences / how he likes to collaborate | Project rules, architecture, in-flight specs |
| Historical incident context that's specific to one Claude session | Anything another agent / human / future me needs to see |
| Ephemeral session state (current task, where I left off) | Decisions that should survive cold starts |

Per `CLAUDE.md`: **every new feature / table / Inngest function / integration / library file must land in `docs/brain/` in the same PR.** Code without a brain page is incomplete. Memory is for Dylan-specific collaboration context; the brain is for the project.

When a spec is in `specs/` and Dylan asks "where did we leave off on X" in a new session, the agent reads:
1. `specs/{slug}.md` — phase emojis show the build state
2. Recent git log on files mentioned in the spec — confirms what actually landed
3. Lifecycle "Status / open work" blocks for any folded content

That triplet answers "what's done, what's next, what's blocked" without Dylan having to brief from scratch.

## Related

[[README]] · [[archive]] · [[dashboard/roadmap]] · [[lifecycles/roadmap-build-console]] · [[lifecycles/spec-goal-branch-pm-flow]] · [[customer-voice]] · [[operational-rules]] · [[lifecycles/ai-learning]] (example of a shipped + folded spec) · [[recipes/pipeline-validation-tests]] (no-op specs for pipeline validation)
