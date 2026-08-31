# deploy-build-gate — the pre-merge `next build` gate

([[../specs/a-red-main-is-a-first-class-pipeline-alarm]] Phase 2)

The pre-merge `next build` gate that runs against a worktree to catch what `tsc --noEmit` structurally cannot see (cacheComponents PRERENDER errors, route-segment-config mismatches). The repo has no CI — `tsc` is the only pre-merge check on the box — but these errors are NOT type errors; they sail past the type checker and break the Vercel production build at deploy time. This module is the extracted, importable gate the [[../../../scripts/builder-worker.ts]] build lane has always run inline as `runNextBuildGate`; extracted so the [[github-pr-resolve]] auto-merge chokepoint can reuse it (one truth, no drift on what counts as a merge-blocking error).

**The asymmetry is deliberate and load-bearing:** the classifier blocks ONLY on the cacheComponents/prerender class (captured in `BUILD_GATE_BLOCK_RE`). A compile / module / binary failure is treated as infra noise (`pass:true`) because it is not the author's code — bouncing it back would loop forever on infrastructure problems. The auto-merge chokepoint and the box build lane both read `classifyBuildGateOutput` so they cannot drift on what counts as merge-blocking.

## Exports

- **`BUILD_GATE_BLOCK_RE`** — the (deliberately narrow) regex matching the blocking class: `Uncached data was accessed outside of <Suspense>`, `Error occurred prerendering page`, `Export encountered an error`, `Route segment config[^\n]*not compatible`. tsc structurally cannot see these; they surface only during a real `next build`. **KEEP THIS REGEX EXACT** — both the build lane and the auto-merge chokepoint read this constant, and both callers' tests pin its shape.

- **`BUILD_GATE_PATH_RE`** — the path-scope predicate matching `src/app/`, `src/components/`, `next.config`, `middleware.` — the gate only pays the ~4-minute `next build` cost when the diff touches code that affects the production build. A docs-only or lib-only diff is safely skipped.

- **`BUILD_GATE_MAX_ATTEMPTS = 3`** — after N consecutive gate failures the build lane surfaces to a human instead of re-dispatching.

- **`shouldRunBuildGate(changedFilesText: string) → boolean`** — true iff the diff touches build-affecting paths (matches `BUILD_GATE_PATH_RE`). The gate should run.

- **`classifyBuildGateOutput(code: number, out: string) → BuildGateResult`** — PURE classifier. Load-bearing asymmetric predicate: block ONLY on the cacheComponents class, treat anything else as infra noise. Returns `{ pass, error, log }`:
  - `pass:true` when exit code is 0, or when the build failed on a non-blocking error (compile / module / binary infra noise)
  - `pass:false` + `error` when the blocking regex matches
  - `log` is the build output tail (2000 chars on pass, 4000 on fail)

- **`runNextBuildGate(wt: string, deps: RunNextBuildGateDeps) → Promise<BuildGateResult>`** — run the gate against worktree at `wt`. Wipes `.next` first (a stale build directory masks prerender errors) then runs `npx next build` with a 15-minute timeout. Deps are REQUIRED (injectable for testing); the builder-worker passes its own shell helpers to preserve exact behavior; the auto-merge chokepoint passes a fresh-checkout pair.

## Where it runs

- **Box build lane:** `scripts/builder-worker.ts` `runNextBuildGate` — invokes this module's gate and dispatches or surfaces the build accordingly.

- **Auto-merge chokepoint:** [[github-pr-resolve]] `autoMergeReadyPrs` — called when a PR whose diff touches build-affecting paths has no record of already passing the gate in the box lane. On fail: refuse merge, count into `deployBuildGateBlocked`, leave PR and branch UNCHANGED. On pass: fall through to squash-merge.

## Verification

- `npm run test:deploy-build-gate` — unit tests covering the blocking regex (prerender class blocks, infra noise passes), path-scope predicate (app/components/next.config/middleware match, lib/docs skip), and the asymmetry (compile failures treated as pass).
- tsc clean.
- Both `scripts/builder-worker.ts` and `src/lib/github-pr-resolve.ts` reference and import the gate correctly.

## Remaining hole (by design, backstopped)

A human merging a PR by hand in the GitHub UI bypasses the auto-merge chokepoint. That is what [[control-tower/main-build-status]] `sweepMainBuildStatus` is the backstop for — the red-main alarm raises a CEO-visible card whatever the cause and whoever merged it, including a hand-authored hotfix or a GitHub UI merge.
