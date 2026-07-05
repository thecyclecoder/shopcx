# libraries/pulse

The founder-pulse synthesizer. Joins [[../tables/pulse_session_digests]] rows (Phase 1) against the [[../tables/specs]] / [[../tables/spec_phases]] ledger via [[specs-table]] `listSpecs` + the `agent_jobs↔specs` join on `spec_slug`, and produces the five lenses that render on `/dashboard/developer/pulse`. Phase 2 of [[../specs/founder-pulse]]. Owner: [[../functions/platform]].

**File:** `src/lib/pulse.ts`

## Why

The digest table is the evidence layer; this module is the reasoning layer. Every claim it emits carries at least one cite (session digest id, spec slug, commit sha, or job id) so the surface never grows a free-floating assertion — the whole point of Phase 2 is that the pulse is auditable back to a real transcript, spec row, or PR. A disposable `scripts/_*` one-off is noise by construction (same class the drift detector already ignores, commit d61e7a18) — the synthesizer filters those before it maps to the lenses.

## Two-stage synthesis

1. **Deterministic join** (`synthesizeDeterministic`) — pure code, unit-testable without an LLM. This is what the Phase-2 verification harness `scripts/_verify-pulse-synthesis.ts` imports and asserts on.
2. **Optional LLM narrative pass** (`narrateWithModel`) — Haiku rewrites each lens's claims in the founder's voice FROM the same structured evidence + cite ids. Reuses the workspace's existing raw-fetch Anthropic client pattern (mirrors [[../libraries/sonnet-orchestrator-v2]] / [[ad-avatar-proposals]]). If the API is unavailable the deterministic prose ships as-is.

**Briefing cap (2026-07-03 fix):** the deterministic join emits one claim per thread across up to 40 digests — left uncapped that's a ~160-claim firehose that both reads as noise AND blows `narrateWithModel`'s output budget (the truncated JSON fails to parse → silent deterministic fallback, so the Pulse looked empty/raw). `synthesizeDeterministic` now dedups near-identical claims (via `normalizeForMatch`) and caps each lens to briefing size (`whats_working` 8 · `where_you_left_off` 10 · `rabbit_holes` 6 · `next_moves` 5 · `threads_in_flight` 10), keeping the most-recent (digests arrive newest-first); `narrateWithModel`'s `max_tokens` was raised to 2400.

## The five lenses

Rendered in this order on `/dashboard/developer/pulse`:

- **whats_working** — threads resolved by ANY of: (a) session-authored `status='resolved'` (authoritative — the assistant witnessed the resolution in-session); (b) an exact-matched spec in a settled/in-flight state (`folded ｜ shipped ｜ in_progress`, or any phase with `build_sha`/`merge_sha`/`pr` set); (c) an exact `kind='pr'` ref whose PR is merged in the workspace ledger (`specs.merged_pr` + `last_merge_sha`, OR any `phases.pr` with `merge_sha`); (d) an exact `kind='commit'` ref — a commit sha is a work-landed signal even without a spec anchor. See "Exact-ref-first reconciliation" below.
- **where_you_left_off** — genuinely open threads (no matching spec / matching spec still `planned`/`in_review`, and no merged-PR/commit ref, and not session-authored `resolved`). Falls back to the most-recent digest's `resume_point` when nothing else surfaces. A session-authored `open` thread surfaces with its original title; a Haiku-ingest match keeps the "no matching spec yet" suffix so the caller can see the classifier ran on a guess.
- **rabbit_holes** — threads the founder marked `status='noise'` in the digest (session-authored takes this as authoritative; Haiku-ingest is still respected).
- **next_moves** — planned/in_review specs, prioritized by whether an OPEN thread already references them (author-resolved and PR-merged and commit-anchored threads don't count as open — same Phase-3 resolution rules as the main fan-out).
- **threads_in_flight** — the open-thread set + any `in_progress`/`in_review` spec + any non-terminal `agent_jobs` row.

## Exact-ref-first reconciliation ([[../specs/pulse-session-authored-recaps]] Phase 3)

The pre-Phase-3 join used a lossy slug-substring guess against the thread title / cite / digest refs — good enough for Haiku's paraphrased digests but wrong when the assistant already knows the exact spec slug, PR number, and commit sha. The session-authored writer emits those as first-class `refs[]` entries; the join now consults them BEFORE the substring fallback:

1. **Exact refs first.** `matchThreadsToSpecs` iterates `digest.refs[]` for each thread:
   - `kind='spec'` → exact slug match against the workspace `listSpecs` result. Ledger-scoped — a slug that isn't in the workspace doesn't resolve.
   - `kind='pr'` → number match against `specs.merged_pr` OR any `spec.phases[].pr` (the ledger-scoped confirming predicate — a bare PR number never claims a spec that isn't the workspace's). Also cross-references the OPEN `agent_jobs` set so an in-flight PR still carries a job cite.
   - `kind='commit'` → recorded as `matchedCommit` (a sha means work landed — see the resolution rules above).
   - `kind='migration' | 'brain' | 'file' | 'url'` → not used for status resolution; still contribute to the substring haystack as a soft signal.
2. **Slug-substring fallback.** Runs only when no exact ref matched anything — preserves the pre-Phase-3 behavior for Haiku-ingest digests and for session-authored digests that forgot to include exact refs. Longest slug wins (same rule as before).

**Session-authored authority.** When `digest_model === 'session-authored'` ([[pulse-digest]] `SESSION_AUTHORED_MODEL`), the thread's explicit `status` is carried as `authorStatus` on the `ThreadMatch` and treated as authoritative — `resolved` bypasses the ledger re-derive, `noise` sends the thread straight to `rabbit_holes`. The assistant SAW the outcome; the pulse join respects that.

**Post-session shipping.** A thread with an exact spec/PR ref that has NOT shipped yet renders as open on the ingest run; when the spec later ships (a phase merges) or the PR later merges, the NEXT `buildPulse` re-derives the status and flips the thread to `whats_working` WITHOUT re-ingesting the digest. That's the "done reads as done" property — the digest is a stable record of what the founder saw; the ledger is what's actually true right now. The join reconciles them at read time.

## Exports

### `LENS_KEYS` — const array
The five lens keys, in render order. The type `LensKey` is the union of these strings.

### `PulseSnapshot` / `PulseLenses` / `LensClaim` / `Cite` — interfaces
The shape of the persisted snapshot. `LensClaim = { claim, cite_ids[] }`; every `cite_ids` entry keys into `snapshot.cites` which carries `{ kind, ref, label }`.

### `isScriptNoise(text): boolean`
Whether a thread title / ref value looks like a disposable one-off script (`scripts/_probe-foo.ts`, `_backfill-bar.ts`, …). Filtered BEFORE the lenses are populated so noise never surfaces as work.

### `isSpecSettledOrInFlight(spec): boolean`
`true` when the spec is `folded`/`shipped`/`in_progress`, OR any phase has a `build_sha`/`merge_sha`/`pr` set — the "this is not open work anymore" test. A thread pointing here counts as RESOLVED and lands under `whats_working`, not `where_you_left_off`.

### `deriveSpecStatus(spec): SpecStatus | 'in_progress' | 'shipped' | 'planned'`
Rolls up the spec's phases the way [[brain-roadmap]] does at read time. Explicit lifecycle overrides (`in_review`/`deferred`/`folded`) win; otherwise phases roll up.

### `matchThreadsToSpecs(digests, specs, jobs?): ThreadMatch[]`
For every thread across every digest, resolve it to a ledger anchor via exact refs first (`kind='spec'` → workspace slug; `kind='pr'` → `specs.merged_pr` / `phases.pr` + open agent_jobs; `kind='commit'` → recorded sha), then fall back to slug-substring matching (longest slug wins). Returns `ThreadMatch { thread, digest, matchedSpec, matchedJob, matchedCommit, matchedPr, matchedVia, authorStatus }`. `authorStatus` is set only for `digest_model === 'session-authored'` digests — the assistant's ground-truth call on that thread. See "Exact-ref-first reconciliation" above.

### `DigestInput` — interface
Adds `digest_model: string | null` (Phase 3) so the join can tell a session-authored digest from a Haiku ingest and apply the authority rule accordingly.

### `synthesizeDeterministic(fixtures, opts?): PulseSnapshot`
The pure-code entry point. Feeds `{ digests, specs, jobs }` to the join and returns a snapshot with every claim already cite-anchored. **This is what the Phase-2 verification harness imports.** Zero-cite claims are filtered out before return — no free-floating assertions escape.

### `narrateWithModel(base, model = HAIKU_MODEL): Promise<PulseSnapshot>`
The optional LLM pass. Rewrites each lens's claims in the founder's voice; drops any rewrite whose `cite_ids` don't resolve back to `base.cites`. On any API failure returns `base` unchanged so the surface never regresses to a blank page.

### `buildPulse({ workspaceId, subject?, narrate?, admin? }): Promise<PulseSnapshot>`
The one-call entrypoint the API route uses. Reads the last 40 digests + all specs + up to 50 non-terminal agent jobs, hands them to `synthesizeDeterministic`, and (when `narrate !== false`) runs `narrateWithModel`.

### `persistPulseSnapshot(admin, workspaceId, snapshot): { synthesized_at }`
Upserts on `(workspace_id, subject)` and returns the persisted timestamp.

### `getPulseSnapshot(admin, workspaceId, subject='founder'): PulseSnapshot | null`
Latest cached snapshot, or null if none.

### `logPulseUsage(workspaceId, model, usage): void`
Wraps [[ai-usage]] `logAiUsage` with `purpose='pulse_narrative'` so cost tracking attributes the narrative pass separately.

## Callers

- `src/app/api/developer/pulse/route.ts` — the owner-gated GET (default: read cache; `?refresh=1` recompute + upsert)
- `scripts/_verify-pulse-synthesis.ts` — the Phase-2 pure-code verification harness (no LLM call)
- `scripts/_verify-pulse-session-authored.ts` — the [[../specs/pulse-session-authored-recaps]] Phase-3 pure-code verification harness (no LLM call) — asserts session-authored + merged-PR ref renders as done, no-spec + commit-sha ref renders as done, post-session shipping flips a same-digest render to done, and the slug-substring fallback still resolves un-ref'd threads.
- `src/app/dashboard/developer/pulse/page.tsx` — Phase 3 (upcoming)

## Gotchas

- **Every claim MUST carry ≥1 non-empty cite.** The deterministic synthesizer filters zero-cite claims before it returns; the LLM narrative pass filters claims whose `cite_ids` don't resolve to `base.cites`. If a lens ever ships a free-floating assertion, the narrative pass is bypassing the cite gate — start there.
- **Longest slug wins.** `matchThreadsToSpecs` sorts slugs by length descending before matching so `founder-pulse-v2` never gets stolen by `founder-pulse`.
- **`scripts/_*` is noise.** Filter with `isScriptNoise` BEFORE mapping to lenses — surfacing a probe script as "work in flight" is the exact drift class the drift detector already ignores (commit d61e7a18).
- **The LLM pass is best-effort.** When `ANTHROPIC_API_KEY` is missing / the call fails, `narrateWithModel` returns `base` unchanged and `snapshot.model === 'deterministic'` — a clean tell in the DB row that the surface is running on the pure-code lane.

## Related

[[../tables/pulse_snapshots]] · [[../tables/pulse_session_digests]] · [[../tables/specs]] · [[../tables/spec_phases]] · [[pulse-digest]] · [[specs-table]] · [[brain-roadmap]] · [[ai-models]] · [[ai-usage]] · [[../specs/founder-pulse]] · [[../functions/platform]] · [[../goals/ceo-mode]]
