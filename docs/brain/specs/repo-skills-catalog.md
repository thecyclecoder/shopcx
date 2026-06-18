# Repo Skills Catalog — committed Claude Code skills for operating ShopCX 🚧

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

ShopCX's first repo-committed Claude Code skills now live in `.claude/skills/` (the P0 four — Phase 1). This spec is the catalog of skills that let an agent — the self-hosted box's headless `claude -p` builds ([[../recipes/build-box-setup]]) **or** an interactive session — build, maintain, and operate ShopCX reproducibly, in version control.

**Architecture note (updated 2026-06-18):** builds run on the **box**, not a Claude Code Routine. The box runs `claude` as a *top-level* process, so `claude -p` is valid there (it was *not* inside a routine — a routine is itself a `claude` session and can't spawn one). Skills are the reusable procedures that top-level `claude -p` draws on; the box can use any skill committed to the repo.

**Why now:** [[roadmap-build-console]] (describe → spec → autonomous build → PR) is shipped end-to-end. The build procedure should live as the committed `build-spec` skill so it's reproducible across the box worker *and* interactive sessions. The same is true for the ~230 operational scripts: they encode a handful of repeatable patterns that should be skills, not copy-paste.

## Two layers (don't conflate)

1. **Runtime orchestrator actions** — what the AI does live during customer service (pause/resume/refund/return/coupon/loyalty/cancel-via-journey/meta-moderation/replies). These already exist as `directActionHandlers` in [[../libraries/action-executor]] + Sonnet data tools; the ~20 customer-action [[../recipes/README|recipes]] *document* them. **Not** Claude Code skills — do not skill-ify each one.
2. **Claude Code skills** — what a build/ops agent needs. **This is the gap this spec fills.** Each maps to existing recipes/scripts that prove the pattern is real.

## Skill foundation (every script shares it)

All 230 `scripts/*.ts` run via `npx tsx scripts/<name>.ts`, load `.env.local` into `process.env`, and use `createAdminClient()` from `src/lib/supabase/admin.ts`. Migrations connect raw via `pg.Client` to the pooler (`:6543`, `SUPABASE_DB_PASSWORD`). A committed `script-conventions` skill + a shared `scripts/_bootstrap.ts` should standardize this.

---

## Phase 1 — P0 skills (the unblockers) 🚧

Committed to the repo as drafts. They need a validation pass + to be wired into the box worker's build before they're load-bearing.

- 🚧 **build-spec** (`.claude/skills/build-spec/`) — read `docs/brain/specs/{slug}.md` → implement every phase → `npx tsc --noEmit` gate → stop-and-surface open questions → `claude/*` PR. The build itself runs as a **top-level `claude -p` on the box** (Max-billed); this skill is the canonical recipe it follows. **Today the box worker (`scripts/builder-worker.ts`) drives builds with an inline prompt that embodies this skill** + owns git/PR; wiring the worker to invoke the skill directly (and letting it own the PR) is a DRY follow-up. Invariant: native tools only — never spawn a *nested* `claude` (recursion).
- 🚧 **probe-db** (`.claude/skills/probe-db/`) — read-only schema/data/enum inspection before assuming anything ("the database is the spec"). Maps to the ~16 `_probe-*`/`_check-*`/`inspect-*` scripts.
- 🚧 **write-migration** (`.claude/skills/write-migration/`) — author `supabase/migrations/YYYYMMDDNNNNNN_*.sql` (idempotent) + an apply-script (pooler `:6543`, `BEGIN/COMMIT` for backfills, **never run during Inngest syncs**). Maps to recipe `write-a-migration-apply-script` + 24 `apply-*-migration.ts`.
- 🚧 **customer-remedy** (`.claude/skills/customer-remedy/`) — scaffold an end-to-end one-customer fix: resolve by **UUID** → fetch state → plan gated steps → execute through `directActionHandlers` → log each gate → idempotent, dry-run-first. Maps to ~40 scripts (`_jay-*`, `_michelle-*`, `cheryl-*`, `brad-*`, `run-refund-playbook`, `setup-mary-recovery-sub`).

## Phase 2 — P1 skills ⏳

- ⏳ **fold-to-brain** — shipped spec → fold into lifecycle/table/lib/inngest pages, update README counts, `git rm` the spec ([[../project-management]]).
- ⏳ **write-brain-page** — scaffold a brain page for any new table/inngest/library/integration (CLAUDE.md hard rule: code without a brain page is incomplete).
- ⏳ **backfill** — chunked, cursor-paginated, resumable, two-phase `--apply`. Maps to 26 `backfill-*` scripts.
- ⏳ **audit-reconcile** — dry-run manifest → `--apply` fix; resumable. Maps to 9 `audit-*`/`reconcile-*`.
- ⏳ **deploy** — `tsc` before commit · don't push during Inngest syncs · branch-not-main. Maps to [[../operational-rules]].

## Phase 3 — P2 skills ⏳

- ⏳ **regenerate-brain** — run the `_gen-brain-*.ts` code→docs generators (4).
- ⏳ **verify-schema** — assert DB enums/columns match brain claims (`_verify-*-schema.ts`).
- ⏳ **edit-shopify-theme** — GitHub source of truth · preview-first · reconcile (recipe + `reconcile-shopify-theme.ts`).
- ⏳ **build-portals** — `node scripts/build-all-portals.js` after editing `shopify-extension/portal-src/`.
- ⏳ **run-orchestrator-action** — invoke `directActionHandlers` from a script (the layer-1 bridge; `apply-coupon-via-executor.ts`).
- ⏳ **fire-inngest-event** — `inngest.send` with exact event names, idempotent, batched (recipe).

## Phase 4 — P3 skills ⏳

- ⏳ **render-static** / **generate-ad** — Remotion render + ad pipeline (benefit-traceability, safe-core, cost cap). Mostly UI-driven today; lowest skill priority. Maps to 8 `render-*` + ad recipes.

## Safety / invariants

- **build-spec uses native tools; never spawns a *nested* `claude`.** On the box the build *is* a top-level `claude -p` (that's the executor); the skill runs inside it and must not spawn another `claude` (recursion / the `CLAUDECODE=1` guard). Max-billed: no `ANTHROPIC_API_KEY` in the build env (`env -u ANTHROPIC_API_KEY`).
- **probe-db is read-only** — no mutations, ever. Throwaway probes use the `_`-prefix naming convention.
- **write-migration / backfill / customer-remedy are idempotent + dry-run-first.** Never run schema/backfill scripts during active Inngest syncs.
- **Internal joins use UUIDs, never `shopify_*_id`** (customer-remedy especially).
- **All DB writes go through `createAdminClient()`** (service role).
- **Skills must be committed** (`.claude/skills/{name}/SKILL.md`) or routines can't see them.

## Completion criteria

- The P0 four are committed `.claude/skills/*/SKILL.md`. The box worker builds a spec → CI-passing `claude/*` PR (✅ proven 2026-06-18 via the smoke test). Remaining: wire the worker to invoke the `build-spec` skill directly (DRY), and exercise probe-db / write-migration / customer-remedy inside a real build.
- Each skill cross-links its source recipe(s)/script pattern, and the catalog is folded into [[../recipes/README]] when stable.

## Related

[[roadmap-build-console]] · [[../recipes/README]] · [[../libraries/action-executor]] · [[../operational-rules]] · [[../project-management]] · [[../lifecycles/agent-todo-system]]
