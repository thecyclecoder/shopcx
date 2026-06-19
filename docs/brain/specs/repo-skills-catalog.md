# Repo Skills Catalog — committed Claude Code skills for operating ShopCX ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

ShopCX's first repo-committed Claude Code skills now live in `.claude/skills/` (the P0 four — Phase 1). This spec is the catalog of skills that let an agent — the self-hosted box's headless `claude -p` builds ([[../recipes/build-box-setup]]) **or** an interactive session — build, maintain, and operate ShopCX reproducibly, in version control.

**Architecture note (updated 2026-06-18):** builds run on the **box**, not a Claude Code Routine. The box runs `claude` as a *top-level* process, so `claude -p` is valid there (it was *not* inside a routine — a routine is itself a `claude` session and can't spawn one). Skills are the reusable procedures that top-level `claude -p` draws on; the box can use any skill committed to the repo.

**Why now:** [[roadmap-build-console]] (describe → spec → autonomous build → PR) is shipped end-to-end. The build procedure should live as the committed `build-spec` skill so it's reproducible across the box worker *and* interactive sessions. The same is true for the ~230 operational scripts: they encode a handful of repeatable patterns that should be skills, not copy-paste.

## Two layers (don't conflate)

1. **Runtime orchestrator actions** — what the AI does live during customer service (pause/resume/refund/return/coupon/loyalty/cancel-via-journey/meta-moderation/replies). These already exist as `directActionHandlers` in [[../libraries/action-executor]] + Sonnet data tools; the ~20 customer-action [[../recipes/README|recipes]] *document* them. **Not** Claude Code skills — do not skill-ify each one.
2. **Claude Code skills** — what a build/ops agent needs. **This is the gap this spec fills.** Each maps to existing recipes/scripts that prove the pattern is real.

## Skill foundation (every script shares it) ✅

All 230 `scripts/*.ts` run via `npx tsx scripts/<name>.ts`, load `.env.local` into `process.env`, and use `createAdminClient()` from `src/lib/supabase/admin.ts`. Migrations connect raw via `pg.Client` to the pooler (`:6543`, `SUPABASE_DB_PASSWORD`).

✅ **Shipped:** a shared `scripts/_bootstrap.ts` (exports `loadEnv()` / `createAdminClient()` / `pgClient()` / `poolerConnectionString()`, replacing the ~150 hand-copied env-loader blocks; `.env.local` read is `existsSync`-guarded so it's a no-op on the box) + a committed `script-conventions` skill (`.claude/skills/script-conventions/SKILL.md`) that documents the foundation, the box `.env.local`-absent gotcha, and the `_`-prefix convention. New scripts import `_bootstrap`; the back catalogue is left as-is (no bulk rewrite).

---

## Phase 1 — P0 skills (the unblockers) ✅

Committed to the repo as drafts. They need a validation pass + to be wired into the box worker's build before they're load-bearing.

- ✅ **build-spec** (`.claude/skills/build-spec/`) — read `docs/brain/specs/{slug}.md` → implement every phase → `npx tsc --noEmit` gate → stop-and-surface open questions → `claude/*` PR. The build itself runs as a **top-level `claude -p` on the box** (Max-billed); this skill is the canonical recipe it follows. ✅ **DRY follow-up done:** the box worker (`scripts/builder-worker.ts`, `runBuild` prompt ~L808) now invokes the skill directly — its build prompt is `Use the build-spec skill to implement the spec at docs/brain/specs/{slug}.md` plus a worker-protocol overlay (harness owns git/PR; no prod creds → request approval). Invariant: native tools only — never spawn a *nested* `claude` (recursion).
- ✅ **probe-db** (`.claude/skills/probe-db/`) — read-only schema/data/enum inspection before assuming anything ("the database is the spec"). Maps to the ~16 `_probe-*`/`_check-*`/`inspect-*` scripts.
- ✅ **write-migration** (`.claude/skills/write-migration/`) — author `supabase/migrations/YYYYMMDDNNNNNN_*.sql` (idempotent) + an apply-script (pooler `:6543`, `BEGIN/COMMIT` for backfills, **never run during Inngest syncs**). Maps to recipe `write-a-migration-apply-script` + 24 `apply-*-migration.ts`.
- ✅ **customer-remedy** (`.claude/skills/customer-remedy/`) — scaffold an end-to-end one-customer fix: resolve by **UUID** → fetch state → plan gated steps → execute through `directActionHandlers` → log each gate → idempotent, dry-run-first. Maps to ~40 scripts (`_jay-*`, `_michelle-*`, `cheryl-*`, `brad-*`, `run-refund-playbook`, `setup-mary-recovery-sub`).

## Phase 2 — P1 skills ✅

Committed to the repo as `.claude/skills/{name}/SKILL.md` drafts (same as the P0 four — each carries a `## Related` cross-link to its source recipe(s)/script pattern). Like Phase 1, they accrue load-bearing validation as real builds exercise them.

- ✅ **fold-to-brain** (`.claude/skills/fold-to-brain/`) — shipped spec → fold into lifecycle/table/lib/inngest pages, update README counts, `git rm` the spec ([[../project-management]]).
- ✅ **write-brain-page** (`.claude/skills/write-brain-page/`) — scaffold a brain page for any new table/inngest/library/integration (CLAUDE.md hard rule: code without a brain page is incomplete).
- ✅ **backfill** (`.claude/skills/backfill/`) — chunked, cursor-paginated, resumable, two-phase `--apply`. Maps to 26 `backfill-*` scripts.
- ✅ **audit-reconcile** (`.claude/skills/audit-reconcile/`) — dry-run manifest → `--apply` fix; resumable. Maps to 9 `audit-*`/`reconcile-*`.
- ✅ **deploy** (`.claude/skills/deploy/`) — `tsc` before commit · don't push during Inngest syncs · branch-not-main. Maps to [[../operational-rules]].

## Phase 3 — P2 skills ✅

Committed to the repo as `.claude/skills/{name}/SKILL.md` drafts (same shape as the P0/P1 skills — each carries a `## Related` cross-link to its source recipe(s)/script pattern). Like the earlier phases, they accrue load-bearing validation as real builds/ops exercise them.

- ✅ **regenerate-brain** (`.claude/skills/regenerate-brain/`) — run the `_gen-brain-*.ts` code→docs generators (4: tables/inngest/libraries/dashboard), `_dump-schema.ts` first for tables, then `brain:index` reconcile.
- ✅ **verify-schema** (`.claude/skills/verify-schema/`) — read-only assert that a table's live columns/indexes/policies match brain/migration claims (`_verify-*-schema.ts`).
- ✅ **edit-shopify-theme** (`.claude/skills/edit-shopify-theme/`) — GitHub source of truth · preview-first · reconcile (recipe + `reconcile-shopify-theme.ts`).
- ✅ **build-portals** (`.claude/skills/build-portals/`) — `node scripts/build-all-portals.js` after editing `shopify-extension/portal-src/`.
- ✅ **run-orchestrator-action** (`.claude/skills/run-orchestrator-action/`) — drive `directActionHandlers` via `executeSonnetDecision` from a script (the layer-1 bridge; `apply-coupon-via-executor.ts`).
- ✅ **fire-inngest-event** (`.claude/skills/fire-inngest-event/`) — `inngest.send` with exact event names, JSON-only payloads, idempotent, batched (recipe).

## Phase 4 — P3 skills ✅

Committed to the repo as `.claude/skills/{name}/SKILL.md` drafts (same shape as the P0–P2 skills — each carries a `## Related` cross-link to its source recipe(s)/script pattern). Like the earlier phases, they accrue load-bearing validation as real ad-render work exercises them.

- ✅ **render-static** (`.claude/skills/render-static/`) — design-led Remotion **still** templates (legacy review/offer/benefit_authority + the cold-50+ killer archetypes) across 1:1/4:5/9:16: edit a `remotion/Static*.tsx` template → render local samples (the `bundle`+`selectComposition`+`renderStill` shape) → redeploy the Lambda site. Invariants: never product-on-white (isolated cutout only), reuse-if-present imagery (no repeat Gemini spend), SafeImg, Meta safe-zone insets. Maps to the 8 `render-*` scripts + [[../lifecycles/ad-static]].
- ✅ **generate-ad** (`.claude/skills/generate-ad/`) — the avatar→angle→script→hero→talking-head→b-roll→render-4-formats video pipeline + the one-beat re-launch refresh. Invariants: benefit-traceability (every claim traces to a tier-1/2 benefit), Meta safe-core, $10 cost cap, NSFW-surfaces. Mostly UI-driven today; the skill is the procedure + invariants behind the studio. Maps to the [[../recipes/generate-ad]] + [[../recipes/ad-relaunch-refresh]] recipes.

## Safety / invariants

- **build-spec uses native tools; never spawns a *nested* `claude`.** On the box the build *is* a top-level `claude -p` (that's the executor); the skill runs inside it and must not spawn another `claude` (recursion / the `CLAUDECODE=1` guard). Max-billed: no `ANTHROPIC_API_KEY` in the build env (`env -u ANTHROPIC_API_KEY`).
- **probe-db is read-only** — no mutations, ever. Throwaway probes use the `_`-prefix naming convention.
- **write-migration / backfill / customer-remedy are idempotent + dry-run-first.** Never run schema/backfill scripts during active Inngest syncs.
- **Internal joins use UUIDs, never `shopify_*_id`** (customer-remedy especially).
- **All DB writes go through `createAdminClient()`** (service role).
- **Skills must be committed** (`.claude/skills/{name}/SKILL.md`) or routines can't see them.

## Completion criteria

- ✅ The P0 four are committed `.claude/skills/*/SKILL.md`. The box worker builds a spec → CI-passing `claude/*` PR (✅ proven 2026-06-18 via the smoke test).
- ✅ The worker invokes the `build-spec` skill directly (DRY) — `scripts/builder-worker.ts` `runBuild` prompt, not an inline copy of the procedure.
- ✅ Skill foundation committed: `scripts/_bootstrap.ts` + the `script-conventions` skill.
- ⏳ Remaining: exercise probe-db / write-migration / customer-remedy inside a real build (empirical — accrues as specs that touch the DB get built).
- ✅ Each skill cross-links its source recipe(s)/script pattern (every SKILL.md has a `## Related`). The catalog folds into [[../recipes/README]] when stable.
- ✅ Phase 4 P3 skills committed (`render-static`, `generate-ad`) — the catalog now covers every layer-2 build/ops pattern (P0–P3).

## Verification

- On `.claude/skills/`, list the directory → expect both `render-static/SKILL.md` and `generate-ad/SKILL.md` present alongside the P0–P2 skills.
- In a Claude Code session in this repo, type `/render-static` and `/generate-ad` → expect each to appear in the user-invocable skills list with the frontmatter `description` shown (skills must be committed or the harness can't see them).
- Open each new `SKILL.md` → expect valid `---`-fenced frontmatter (`name` matching the directory, a one-line `description` starting "Use to…/Use when…"), a `## Guardrails` section, and a `## Related` section cross-linking its source recipe(s)/script pattern (`render-statics-deck.ts`/`render-advertorial-*.ts` for render-static; `recipes/generate-ad.md` + `ad-relaunch-refresh.md` for generate-ad).
- Read `render-static`'s guardrails → expect the load-bearing invariants surfaced verbatim from the lifecycle: never product-on-white (isolated cutout only), SafeImg + fresh signed URLs, redeploy the Lambda site after editing `remotion/`.
- Read `generate-ad`'s guardrails → expect benefit-traceability (every claim traces to a tier-1/2 benefit), Meta safe-core (Reels 35% bottom strictest), and the $10 `ad_tool_settings.cost_cap_cents` cap.
- Run `npx tsc --noEmit` → expect no new errors (this phase is docs/skills only — no TS touched).

## Related

[[roadmap-build-console]] · [[../recipes/README]] · [[../libraries/action-executor]] · [[../operational-rules]] · [[../project-management]] · [[../lifecycles/agent-todo-system]]
