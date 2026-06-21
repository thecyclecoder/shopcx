# libraries/spec-green-writeback

Reflect a spec's **green verification state** back onto its markdown file — prepend/strip a leading ✅
on each `## Verification` bullet and commit to `main`. Built for [[../specs/spec-test-maximize-machine-coverage]]
Phase 3 (the founder watches the spec file turn green as checks pass / he tests).

**File:** `src/lib/spec-green-writeback.ts`

## Exports

### `reflectSpecGreenChecks` — function

```ts
async function reflectSpecGreenChecks(workspaceId: string, slug: string): Promise<GreenWritebackResult>
```

Recomputes the green state of every `## Verification` bullet (a bullet is green iff its latest-agent
check is `pass` OR the owner resolved it `verified` — see `deriveGreenBullets` in
[[spec-test-runs]]), rewrites each bullet's first line in `docs/brain/specs/{slug}.md` to carry a
leading ✅ iff green (stripping it otherwise), and commits the change to `main` via the GitHub Contents
API. Idempotent (no-op commit when the file already matches). **Best-effort — never throws**: a failed
fetch/commit returns `{ ok:false, reason }` so it can't break the owner's ✓ Tested click or a box run.
It only ever edits the leading ✅ of a verification bullet — never the spec's logic.

### `GreenWritebackResult` — interface

`{ ok, changed, allGreen, greenCount, total, reason? }`.

## Callers

- `scripts/builder-worker.ts` → `runSpecTestJob` — after a spec-test run lands (agent `pass` checks → ✅).
- `src/app/api/developer/spec-test/human-queue/route.ts` `POST` — owner marks ✓ Tested (→ ✅) or re-opens (→ clear).

## Gotchas

- Needs `GITHUB_TOKEN` (or `AGENT_TODO_GITHUB_TOKEN`) in the runtime env — present on the box worker and
  in the Vercel API runtime (same token the Improve agent uses to commit ticket specs). Absent → skips.
- Reads + writes `main` directly (not the deployed bundle's local disk) so the writeback is canonical;
  the change surfaces in the rendered spec after the commit + next deploy. The VerificationCard renders
  the live green state immediately (independent of the commit) so the founder isn't gated on a deploy.
- Bullet identity is the `checkKey` hash of the bullet text — the agent's `check.text` and the spec
  bullet must match (whitespace-normalized) for a `pass` to land green, the same assumption the
  human-test queue already relies on.

---

[[../README]] · [[../../CLAUDE]] · [[spec-test-runs]] · [[../specs/spec-test-maximize-machine-coverage]]
