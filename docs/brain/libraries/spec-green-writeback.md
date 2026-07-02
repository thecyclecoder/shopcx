# libraries/spec-green-writeback

Compute a spec's **green verification state** from the DB — every `## Verification` bullet's latest
agent check + owner resolution. Historically one of the six git-committing status writers that PUT
`docs/brain/specs/{slug}.md` to `main`; all six were retired to DB writes in
[[../specs/spec-status-db-driven]], and under [[../specs/retire-md-spec-writers-db-is-sole-spec]]
Phase 2 this surface is **compute-only** — no git write path exists.

**File:** `src/lib/spec-green-writeback.ts`

## Exports

### `reflectSpecGreenChecks` — function

```ts
async function reflectSpecGreenChecks(workspaceId: string, slug: string): Promise<GreenWritebackResult>
```

Recomputes the green state of every `## Verification` bullet (a bullet is green iff its latest-agent
check is `pass` OR the owner resolved it `verified` — see `deriveGreenBullets` in
[[spec-test-runs]]) and returns the counts. **No markdown mutation, no `main` commit** — the
dashboard renders the DB-derived state live, and callers use `allGreen` for the all-green → archive
hand-off. Best-effort: a DB read blip returns `{ ok:false, reason }`.

`changed` is always `false` under DB-is-the-spec (there is nothing to change on disk).

### `GreenWritebackResult` — interface

`{ ok, changed, allGreen, greenCount, total, reason? }`.

## Callers

- `scripts/builder-worker.ts` → `runSpecTestJob` — after a spec-test run lands (agent `pass` checks
  contribute to the green count).
- `src/app/api/developer/spec-test/human-queue/route.ts` `POST` — owner marks ✓ Tested / re-opens.

## Gotchas

- Reads the spec body from the DB via [[../libraries/brain-roadmap]] `getSpec` (which reconstructs
  the `## Verification` section from `public.specs` + `public.spec_phases`). No filesystem or
  GitHub Contents fetch.
- Bullet identity is the `checkKey` hash of the bullet text — the agent's `check.text` and the
  DB-authored bullet must match (whitespace-normalized) for a `pass` to land green, the same
  assumption the human-test queue relies on.
- The VerificationCard renders the same green state independently of this call — the founder never
  waits on a deploy to see progress.

---

[[../README]] · [[../../CLAUDE]] · [[spec-test-runs]] · [[../specs/spec-test-maximize-machine-coverage]] · [[../specs/spec-status-db-driven]] · [[../specs/retire-md-spec-writers-db-is-sole-spec]]
