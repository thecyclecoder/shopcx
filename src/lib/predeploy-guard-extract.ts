/**
 * libraries/predeploy-guard-extract — name WHICH guard in the `predeploy:static` chain rejected a build.
 *
 * Part of predeploy-gate-repairs-in-session. The build lane runs the ~21 hermetic `scripts/_check-*.ts`
 * guards as a blocking pre-commit step ([[../../docs/brain/operational-rules]] § Predeploy static guards).
 * When the chain exits non-zero the lane needs to tell Bo — and, on cap exhaustion, the CEO — which rail
 * actually broke, because each guard prints its own remediation next to its failure line.
 *
 * WHY ITS OWN MODULE. This lives here, not in `scripts/builder-worker.ts`, for one hard reason: importing
 * `builder-worker.ts` BOOTS THE WORKER (module-level main loop + reaper). A unit test that imported it to
 * reach this function started a real worker, whose reaper "healed" the developer's git worktree back to
 * main and discarded the uncommitted work (observed 2026-08-11). Pure helpers the worker needs must be
 * importable WITHOUT that side-effect. No I/O, no imports — safe to unit-test and safe to call from
 * anywhere.
 *
 * WHY THE MULTI-SHAPE PARSE. The predecessor was a single `/❌\s*(check-[^\s—]+)/` against the chain's
 * combined stdout+stderr, which silently failed the common case: the guards do NOT share one output
 * format. Some print `❌ check-foo — remediation`, some print `❌ <prose>` with no slug, some only surface
 * through npm's lifecycle frame, and some just exit non-zero from a stack. On 2026-08-10, 4 of the 6 builds
 * that parked on this gate reported the literal string "unknown check" — a park with no remediation, and a
 * retry with nothing new to act on.
 */

/**
 * Resolve every distinct guard named anywhere in a `predeploy:static` failure output.
 *
 * Tries three known shapes and returns the union, deduped, in first-seen order. Guard names are normalized
 * onto the `check-foo` form the guards' own `❌` lines use (npm's `check:foo` script form maps onto it), so
 * the same guard surfacing through two shapes counts once.
 *
 * Returns an EMPTY array when the output is genuinely unattributable — the caller renders that as
 * "unattributable guard (see log_tail)". Never invents a name: a wrong guard name would point Bo's repair
 * pass at the wrong file, which is worse than admitting we don't know.
 */
export function extractFailedPredeployGuards(out: string): string[] {
  // (0) npm's PER-SCRIPT echo — `> shopcx-init@0.1.0 check:foo` — is AUTHORITATIVE when present, and
  // takes precedence over the union below. Because `predeploy:static` chains its guards with `&&`,
  // npm echoes each script as it starts and stops at the first failure: the LAST echoed `check:*` IS
  // the one that broke.
  //
  // Without this, shape (b) matches the chain's own header line (`> npm run check:a && npm run
  // check:b && …`) and returns ALL ~21 guards as "failing" — which lands in `agent_jobs.error`, is
  // what the needs-attention classifier buckets on, and points a repair pass at 21 files instead of
  // one. Verified against real `npm run predeploy:static` output 2026-08-11.
  const echoes = [...out.matchAll(/^\s*>\s+\S+@\S*\s+(check:[a-z0-9-]+)\s*$/gim)];
  const lastEcho = echoes.at(-1)?.[1];
  if (lastEcho) return [lastEcho.replace(/^check:/, "check-")];

  const found: string[] = [];
  const push = (raw: string | undefined) => {
    const g = String(raw || "").trim().replace(/[.,:;]+$/, "");
    if (!g) return;
    const norm = g.replace(/^check:/, "check-");
    if (!found.includes(norm)) found.push(norm);
  };
  // (a) the guards' own failure line: `❌ check-foo — remediation…`
  for (const m of out.matchAll(/❌\s*(check-[a-z0-9-]+)/gi)) push(m[1]);
  // (b) npm's lifecycle frame for the failing script in the `&&` chain:
  //     `npm error Lifecycle script `check:foo` failed` / `npm error command … npm run check:foo`
  for (const m of out.matchAll(/(?:script|npm run)\s+[`'"]?(check:[a-z0-9-]+)/gi)) push(m[1]);
  // (c) our own `scripts/_check-<name>.ts` path, printed in a stack trace or an exec echo
  for (const m of out.matchAll(/scripts\/_?(check-[a-z0-9-]+)\.ts/gi)) push(m[1]);
  return found;
}
