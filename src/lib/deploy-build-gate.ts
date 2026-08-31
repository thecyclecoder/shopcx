/**
 * deploy-build-gate — the pre-merge `next build` gate the box lane uses to catch what tsc can't
 * ([[../specs/a-red-main-is-a-first-class-pipeline-alarm]] Phase 2).
 *
 * The repo has no CI; `tsc --noEmit` is the only pre-merge check on the box — but cacheComponents
 * PRERENDER errors + route-segment-config errors are NOT type errors, so they sail past tsc and
 * break the Vercel production build. This module is the extracted, importable gate that runs a REAL
 * `next build` in a worktree and blocks ONLY on the cacheComponents/prerender class: a compile /
 * module / binary failure is treated as infra noise (not the author's code — bouncing it back would
 * loop forever). That asymmetry is DELIBERATE and LOAD-BEARING; the pure `classifyBuildGateOutput`
 * classifier pins it so the auto-merge chokepoint and the build lane share ONE truth.
 *
 * Previously the gate lived inside `scripts/builder-worker.ts` (as `runNextBuildGate`). Extracted so
 * the auto-merge chokepoint in [[github-pr-resolve]] `autoMergeReadyPrs` can reuse it — the 2026-08-31
 * incident had the exact prerender-class failure that the gate was written to catch, but the failing
 * PR came in on a hand-authored branch that never passed through the box build lane, so the gate
 * never ran. Extending its reach is the whole point of Phase 2.
 *
 * Importing `scripts/builder-worker.ts` from `src/lib/**` would boot the worker (its module top-level
 * has side effects), so this module MUST NOT re-import it. It takes shell helpers as injected `deps`
 * — the builder-worker passes its own `sh` / `shAsync` (preserving EXACT behavior), and callers that
 * only want the pure classifier need no shell at all.
 */
import { join } from "path";

/**
 * The (deliberately narrow) regex matching the cacheComponents / prerender / route-segment-config
 * class the gate is written to catch. tsc structurally cannot see these — they surface only during a
 * real `next build`. Everything else (compile / module / binary failure) is treated as infra noise.
 * KEEP THIS REGEX EXACT — the auto-merge chokepoint and the build lane both read this constant, and
 * both callers' tests pin its shape.
 */
export const BUILD_GATE_BLOCK_RE =
  /Uncached data was accessed outside of <Suspense>|Error occurred prerendering page|Export encountered an error|Route segment config[^\n]*not compatible/;

/**
 * The path-scope predicate — the gate only pays the ~4-minute `next build` cost when the diff touches
 * code that affects the production build. A docs-only or lib-only diff is safely skipped.
 */
export const BUILD_GATE_PATH_RE = /(?:^|\n)(src\/app\/|src\/components\/|next\.config|middleware\.)/;

/** After N consecutive gate failures the build lane surfaces to a human instead of re-dispatching. */
export const BUILD_GATE_MAX_ATTEMPTS = 3;

export interface BuildGateResult {
  /** true = safe to merge (either the build passed, or it failed on non-blocking infra noise). */
  pass: boolean;
  /** the single-line failure reason when pass=false; empty when pass=true. */
  error: string;
  /** the tail of the build output (bounded for log-tail storage). */
  log: string;
}

/** true iff the diff touches build-affecting paths — the gate should run. */
export function shouldRunBuildGate(changedFilesText: string): boolean {
  return BUILD_GATE_PATH_RE.test(changedFilesText);
}

/**
 * PURE — classify a `next build` exit code + combined stdout/stderr into a BuildGateResult.
 * This is the load-bearing asymmetric predicate: block ONLY on the cacheComponents class, treat
 * anything else as infra noise. Both the build lane and the auto-merge chokepoint read this one
 * function so they can't drift on what counts as "the merge-blocking error class."
 */
export function classifyBuildGateOutput(code: number, out: string): BuildGateResult {
  if (code === 0) return { pass: true, error: "", log: out.slice(-2000) };
  const blocking = BUILD_GATE_BLOCK_RE.exec(out);
  if (!blocking) {
    console.warn(
      `[build-gate] next build failed but NOT a prerender/config error (infra/transient — NOT blocking the merge): ${out.slice(-400).replace(/\s+/g, " ")}`,
    );
    return { pass: true, error: "", log: out.slice(-2000) };
  }
  const m = /Error: Route "[^"]+": [^\n]+/.exec(out) || /Route segment config[^\n]+/.exec(out) || blocking;
  return { pass: false, error: m[0].replace(/\s+/g, " ").slice(0, 600), log: out.slice(-4000) };
}

export interface RunNextBuildGateDeps {
  /** Synchronous shell exec — SAME signature as builder-worker.ts's `sh`. */
  runShellSync: (cmd: string, args: string[], opts?: { cwd?: string }) => { code: number; out: string; err: string };
  /** Async shell exec — SAME signature as builder-worker.ts's `shAsync`, with a required timeout. */
  runShellAsync: (
    cmd: string,
    args: string[],
    opts: { timeout?: number; cwd?: string },
  ) => Promise<{ code: number; out: string; err: string }>;
}

/**
 * Run the extracted deploy build gate against the worktree at `wt`. Wipes `.next` first (a stale
 * `.next` masks prerender errors — the build MUST be clean) then runs `npx next build` with a
 * 15-minute timeout. Returns the classifier's verdict verbatim.
 *
 * Deps ARE required — this module never boots a shell helper of its own, so a caller must pass in
 * the runtime-appropriate `sh` / `shAsync`. The builder-worker passes its own (preserves EXACT
 * behavior); the auto-merge chokepoint passes a fresh-checkout-shaped pair.
 */
export async function runNextBuildGate(wt: string, deps: RunNextBuildGateDeps): Promise<BuildGateResult> {
  // Wipe .next — a stale build directory serves stale prerenders that mask the error.
  deps.runShellSync("rm", ["-rf", join(wt, ".next")]);
  const nb = await deps.runShellAsync("npx", ["next", "build"], { timeout: 15 * 60 * 1000, cwd: wt });
  const out = `${nb.out}\n${nb.err}`;
  return classifyBuildGateOutput(nb.code, out);
}
