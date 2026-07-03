# libraries/pulse

The founder-pulse synthesizer. Joins [[../tables/pulse_session_digests]] rows (Phase 1) against the [[../tables/specs]] / [[../tables/spec_phases]] ledger via [[specs-table]] `listSpecs` + the `agent_jobs↔specs` join on `spec_slug`, and produces the five lenses that render on `/dashboard/developer/pulse`. Phase 2 of [[../specs/founder-pulse]]. Owner: [[../functions/platform]].

**File:** `src/lib/pulse.ts`

## Why

The digest table is the evidence layer; this module is the reasoning layer. Every claim it emits carries at least one cite (session digest id, spec slug, commit sha, or job id) so the surface never grows a free-floating assertion — the whole point of Phase 2 is that the pulse is auditable back to a real transcript, spec row, or PR. A disposable `scripts/_*` one-off is noise by construction (same class the drift detector already ignores, commit d61e7a18) — the synthesizer filters those before it maps to the lenses.

## Two-stage synthesis

1. **Deterministic join** (`synthesizeDeterministic`) — pure code, unit-testable without an LLM. This is what the Phase-2 verification harness `scripts/_verify-pulse-synthesis.ts` imports and asserts on.
2. **Optional LLM narrative pass** (`narrateWithModel`) — Haiku rewrites each lens's claims in the founder's voice FROM the same structured evidence + cite ids. Reuses the workspace's existing raw-fetch Anthropic client pattern (mirrors [[../libraries/sonnet-orchestrator-v2]] / [[ad-avatar-proposals]]). If the API is unavailable the deterministic prose ships as-is.

## The five lenses

Rendered in this order on `/dashboard/developer/pulse`:

- **whats_working** — threads that match a spec in a settled or in-flight state (`folded ｜ shipped ｜ in_progress`, or any phase with `build_sha`/`merge_sha`/`pr` set).
- **where_you_left_off** — genuinely open threads (no matching spec, or the matching spec is still `planned`/`in_review`). Falls back to the most-recent digest's `resume_point` when nothing else surfaces.
- **rabbit_holes** — threads the founder marked `status='noise'` in the digest.
- **next_moves** — planned/in_review specs, prioritized by whether an open thread already references them.
- **threads_in_flight** — the open-thread set + any `in_progress`/`in_review` spec + any non-terminal `agent_jobs` row.

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

### `matchThreadsToSpecs(digests, specs): ThreadMatch[]`
For every thread across every digest, find the spec whose slug appears in the thread's title / cite / the digest's refs. Longest slug wins so `founder-pulse-v2` beats `founder-pulse`.

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
- `src/app/dashboard/developer/pulse/page.tsx` — Phase 3 (upcoming)

## Gotchas

- **Every claim MUST carry ≥1 non-empty cite.** The deterministic synthesizer filters zero-cite claims before it returns; the LLM narrative pass filters claims whose `cite_ids` don't resolve to `base.cites`. If a lens ever ships a free-floating assertion, the narrative pass is bypassing the cite gate — start there.
- **Longest slug wins.** `matchThreadsToSpecs` sorts slugs by length descending before matching so `founder-pulse-v2` never gets stolen by `founder-pulse`.
- **`scripts/_*` is noise.** Filter with `isScriptNoise` BEFORE mapping to lenses — surfacing a probe script as "work in flight" is the exact drift class the drift detector already ignores (commit d61e7a18).
- **The LLM pass is best-effort.** When `ANTHROPIC_API_KEY` is missing / the call fails, `narrateWithModel` returns `base` unchanged and `snapshot.model === 'deterministic'` — a clean tell in the DB row that the surface is running on the pure-code lane.

## Related

[[../tables/pulse_snapshots]] · [[../tables/pulse_session_digests]] · [[../tables/specs]] · [[../tables/spec_phases]] · [[pulse-digest]] · [[specs-table]] · [[brain-roadmap]] · [[ai-models]] · [[ai-usage]] · [[../specs/founder-pulse]] · [[../functions/platform]] · [[../goals/ceo-mode]]
