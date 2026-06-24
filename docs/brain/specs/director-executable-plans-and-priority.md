# Ada executes CEO plans + a critical-spec priority lane 🚧

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — extends the coaching seat ([[director-proposed-goals]] pattern) + the standing pass under [[../goals/devops-director]]
**Found in use 2026-06-24:** the CEO wants to (1) hand Ada a PLAN through the ask/coach chat that **trumps her day-to-day** until done, and (2) mark a spec **critical** so it builds before everything (and can gate the assembly line until an in-flight fix lands, so no more build errors compound). Today the chat only has `ask`/`coach` and the build queue has no priority — every spec is equal, FIFO-ish.

## North star — the CEO directs; the rails hold
A directive re-prioritizes WHAT Ada does, never loosens HOW. Her leash, loop-guard, soundness gate, and escalation rails are unchanged — a directive can say "build X first / gate builds until Y," not "blind-merge Z." The CEO approves every directive (it's a chat card) and can clear it anytime.

## Phase 0 — Ada can EDIT existing specs (not only author new ones) ✅
- The coaching seat had a `spec` card (creates a NEW spec) but no way to MODIFY an existing one — so "Ada, update the milestone specs Pia made to add the right `**Blocked-by:**` lines" could only yield a *recommendation*. Added a **`spec-edit` card**: `{ summary, slug, content }` where `content` is the FULL updated markdown of an EXISTING `docs/brain/specs/{slug}.md`. Ada reads the spec read-only, edits it, and emits the card; on CEO approval the worker commits the updated file (guarded: the spec must already exist in the worktree — a `spec-edit` never creates). She may emit several (one per spec) to revise a whole milestone set in one turn.
- Shipped in `scripts/builder-worker.ts` `runDirectorCoachJob` (schema `DIRECTOR_COACH_OUTPUT` + `directorCoachFraming` + the ASK directive advertise it; `normalizeCoachActions` validates it; the executor commits via `putFileMain` after an `existsSync` guard) + `director-coach-chat.tsx` (renders the `spec edit` card). tsc clean.

## Phase 1 — the `plan` intent + directive store + critical marker ✅
- **Third chat intent `plan`** (alongside `ask`/`coach`) in [[../tables/director_coach_threads]] / `runDirectorCoachJob`. The CEO says "execute this plan: …"; Ada investigates read-only and emits a **`directive` card**: `{ summary, steps[], gateBuildsUntil?, criticalSpecs[]? }`.
- **`director_directives` table** (migration): `id, workspace_id, director_function, summary, steps jsonb, gate_builds_until text, status (active|done|cleared), created_by, created_at, completed_at`. One **active** directive per director.
- **On CEO approval** the worker: inserts the directive `status='active'`; for each `criticalSpecs` slug, commits a line-anchored `**Priority:** critical` marker into `docs/brain/specs/{slug}.md`. Writes a `directive_accepted` [[../tables/director_activity]] row.
- **Critical marker** in [[../libraries/brain-roadmap]] (mirrors the `deferred` derive, #423): a spec is `critical` when it carries a line-anchored `**Priority:** critical`. Rendered as a pip/lane on the [[../dashboard/roadmap|board]]; settable from the board too.

**Shipped:**
- **Directive store** — `supabase/migrations/20260707120000_director_directives.sql` (table + a **partial unique index** `where status='active'` = one active per director) · apply `npx tsx scripts/apply-director-directives-migration.ts` · brain page [[../tables/director_directives]].
- **`plan` intent + `directive` card** in `scripts/builder-worker.ts` `runDirectorCoachJob`: the `intent` type + `intentDirective` PLAN branch advertise it; `DIRECTOR_COACH_OUTPUT` + `directorCoachFraming` teach Ada the card; `normalizeCoachActions` validates `{summary, steps[], gateBuildsUntil?, criticalSpecs[]}`; the `approve_action` executor clears any prior active directive, inserts the new one `status='active'`, marks each `criticalSpecs` slug `**Priority:** critical` via `setCriticalMarker` (committed with `putFileMain`), and writes a `directive_accepted` [[../tables/director_activity]] row. `/api/director/coach` threads `intent:'plan'`; `director-coach-chat.tsx` renders the directive card (steps + gate/critical chips) and adds a **Plan** button.
- **Critical marker** in `src/lib/brain-roadmap.ts`: `SpecCard.critical` derived from a line-anchored `**Priority:** critical` (mirrors the `deferred` derive); shared writer `setCriticalMarker(md, critical)`. Board lever: `PriorityControl.tsx` + `POST /api/roadmap/priority` (owner-gated, commits to `main`); the board card shows a 🔴 pip. Phase 2 (the build picker ordering on `critical` + the gate) is still ⏳.

## Phase 2 — the standing pass obeys (directive-first, then routine) ⏳
- `runPlatformDirectorStandingPass` loads the one `active` directive and **runs it FIRST**, injected at the top of her reasoning, before the routine lanes (escort → fix → groom → initiate). After the directive step, routine continues **if there's capacity** (decision: directive-first-then-routine, not directive-only).
- **Build-gate:** if the active directive has `gate_builds_until = <spec>` (or any `critical` spec is unshipped and flagged blocking), the **build-enqueue lanes pause** (initiation + goal-escort + fix-escort STOP queuing new builds); grooming/fold continue. The gate **auto-lifts** when the gating spec ships (`status === 'shipped'`), and the directive auto-completes (`status='done'`, `directive_completed` activity row).
- **Critical-first ordering:** `findInitCandidates` / the build picker sort `critical` specs ahead of normal ones, so a critical spec is queued before the rest even without a hard gate.

## Phase 3 — surfacing + "Ada knows" ⏳
- The active directive + the gate show on the [[../dashboard/agents|Agents hub]] / her profile and in the daily board-watch note ("focused on directive X · builds gated on Y").
- **Ada knows her new powers:** `directorCoachFraming` + the standing-pass framing + her brain page ([[../libraries/platform-director]]) describe the `plan`/`directive` flow, the gate, and the critical marker — so she emits directive cards, respects the gate, and can explain all of it when asked.

### Verification

**Phase 1 (shipped):**
- Apply the migration (`npx tsx scripts/apply-director-directives-migration.ts`) → expect `public.director_directives` present with the partial-unique index `director_directives_one_active_idx`.
- In the chat (`/dashboard/agents/platform` → Coach Ada), type a plan and press **Plan** → expect Ada to reply + emit a `directive` card showing the ordered steps and (if given) a "⛔ gate builds until …" / "🔴 critical: …" chip.
- Press **Make it my directive** on that card → expect exactly one `director_directives` row `status='active'` for `platform` (any prior active row flipped to `cleared`), a `directive_accepted` row in `director_activity`, and each `criticalSpecs` slug's `docs/brain/specs/{slug}.md` now carrying a `**Priority:** critical` line on `main`.
- On `/dashboard/roadmap`, a spec with the marker → expect a 🔴 pip on its card; as owner, click **Mark critical** / **🔴 Critical** on another spec → expect `POST /api/roadmap/priority` to commit (add/remove the marker) and the pip to toggle on reload.
- `npx tsc --noEmit` clean.

**Phases 2–3 (not yet built):**
- On the next standing pass, Ada pursues the directive first; with `gate_builds_until` set, no new build is enqueued until that spec ships, then the gate lifts + the directive completes. A `critical` spec is queued ahead of normal Planned specs.
- Asked "what are you working on?" Ada names the active directive + the gate.

## Open decision (resolved)
Directive-first-then-routine (not directive-only); build BOTH levers (the chat build-gate + the `**Priority:** critical` board marker). — CEO, 2026-06-24.
