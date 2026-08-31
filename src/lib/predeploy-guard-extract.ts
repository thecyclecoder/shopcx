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

/**
 * Pull the repo-relative source paths a predeploy guard named as violating, out of the chain's combined
 * stdout+stderr. Covers the two shapes our guards actually emit — the `• {file}:{line}  →  {snippet}` line
 * and the `[VIOLATION] {file}:{line}  {snippet}` line (see `scripts/_check-competitors-sdk-compliance.ts`
 * lines 113 / 121 for canonical examples).
 *
 * Anchors on paths that start with `src/`, `scripts/`, `supabase/`, or `docs/` and dedupes in first-seen
 * order. Deliberately IGNORES the `> shopcx-init@… check:foo` / `> tsx scripts/_check-foo.ts` npm
 * lifecycle frame so the chain header can never be mistaken for a violation — the same defensive
 * property `extractFailedPredeployGuards`' `lastEcho` rule already carries.
 *
 * Pure, no I/O. Empty return means "no path attributable" — the caller must fall back to the existing
 * repair-it behavior, never silently skip. That fail-closed default is the load-bearing rule of the
 * owned-vs-inherited split ([[classifyPredeployViolationScope]]).
 */
export function extractPredeployViolationPaths(out: string): string[] {
  const found: string[] = [];
  const push = (raw: string) => {
    const p = raw.trim();
    if (!p) return;
    if (!found.includes(p)) found.push(p);
  };

  // Consider the output LINE BY LINE so we can drop npm lifecycle frames without them consuming a real
  // violation on the following line.
  for (const rawLine of out.split(/\r?\n/)) {
    const line = rawLine;
    // Skip npm lifecycle frames — `> shopcx-init@0.1.0 check:foo` and the guard's own
    // `> tsx scripts/_check-foo.ts` runner echo. Either would inject `scripts/…` into the extraction.
    if (/^\s*>\s+\S/.test(line)) continue;

    // Shape (a): `  • {file}:{line}  →  {snippet}`
    for (const m of line.matchAll(
      /(?:^|\s)•\s+((?:src|scripts|supabase|docs)\/[^\s:]+):\d+/g,
    )) {
      push(m[1]);
    }
    // Shape (b): `  [VIOLATION] {file}:{line}  {snippet}`
    for (const m of line.matchAll(
      /\[VIOLATION\]\s+((?:src|scripts|supabase|docs)\/[^\s:]+):\d+/g,
    )) {
      push(m[1]);
    }
  }

  return found;
}

/**
 * Split the violation paths named in a predeploy failure into ones the branch OWNS (its diff touched them)
 * and ones the branch INHERITED from main (the file was already broken before this commit). Enables the
 * build lane to repair only what it caused instead of racing N concurrent branches to the same fix on a
 * pre-existing violation — the failure mode measured 2026-08-31 that parked the cold-scaler and
 * creative-scout builds on the same three _kcups files for six days.
 *
 * Both sides are normalized before comparison: leading `./` stripped, backslashes replaced with `/`.
 *
 * `allInherited` is TRUE only when at least one path was extracted AND none of them appears in
 * `changedPaths`. An EMPTY extraction (guard output we could not parse) yields `allInherited: false` so the
 * caller falls back to the current repair-it behavior rather than silently skipping a real violation —
 * fail-closed by design.
 *
 * Pure, no I/O.
 */
export function classifyPredeployViolationScope(input: {
  out: string;
  changedPaths: string[];
}): { owned: string[]; inherited: string[]; allInherited: boolean; paths: string[] } {
  const normalize = (p: string): string => {
    let s = String(p || "").trim();
    s = s.replace(/\\/g, "/");
    while (s.startsWith("./")) s = s.slice(2);
    return s;
  };

  const paths = extractPredeployViolationPaths(input.out).map(normalize);
  const changed = new Set(input.changedPaths.map(normalize));

  const owned: string[] = [];
  const inherited: string[] = [];
  for (const p of paths) {
    if (changed.has(p)) owned.push(p);
    else inherited.push(p);
  }

  // Fail-closed: no paths extracted → NOT all-inherited (caller repairs). Load-bearing: an unparseable
  // guard output must never masquerade as "nothing this branch owns".
  const allInherited = paths.length > 0 && owned.length === 0;

  return { owned, inherited, allInherited, paths };
}

/**
 * Predeploy Fix 1 — the caller-side safe wrapper for [[classifyPredeployViolationScope]].
 *
 * Returns `null` — i.e. "do NOT enter the inherited-skip branch; caller falls through to today's
 * repair-it behavior" — whenever the caller cannot honestly answer "did this branch touch that file?":
 *
 *   1. `changedPathsResult.ok === false` — the `git diff --name-only` command FAILED. We refuse to
 *      classify against an empty stand-in list, because that list would silently route EVERY extracted
 *      violation into `inherited` and trigger a false skip.
 *   2. `changedPathsResult.paths.length === 0` — the diff succeeded but reported zero changed files. On
 *      a real build branch this is degenerate: if we call the classifier with `changedPaths=[]`, every
 *      extracted path lands in `inherited`, and `allInherited` flips to true — the exact same silent
 *      skip. The safe-wrapper refuses.
 *
 * Otherwise it delegates to `classifyPredeployViolationScope`. The wrapper exists so the worker's
 * `predeploy:static` repair loop can call it once per iteration, AFTER re-running the branch diff, and
 * so the "did the diff work?" and "is the branch actually populated?" checks live in ONE place with a
 * type-level guarantee (returning `null` beats the caller forgetting to check `ok`).
 *
 * Called by [[../../scripts/builder-worker]] `runBuildJob` predeploy:static block ONLY. Kept in this
 * pure module so a unit test can prove the fail-closed default without booting the worker.
 */
export function classifyPredeployViolationScopeIfSafe(input: {
  out: string;
  changedPathsResult: { ok: boolean; paths: string[] };
}): { owned: string[]; inherited: string[]; allInherited: boolean; paths: string[] } | null {
  if (!input.changedPathsResult.ok) return null;
  if (input.changedPathsResult.paths.length === 0) return null;
  return classifyPredeployViolationScope({
    out: input.out,
    changedPaths: input.changedPathsResult.paths,
  });
}
