# libraries/npm-audit-actionable

The one predicate deciding whether an `npm audit --json` advisory is **actionable**: severity is moderate or higher AND a real fix exists. A fix that **downgrades** its package does not count.

**File:** `src/lib/npm-audit-actionable.ts` · **Test:** `src/lib/npm-audit-actionable.test.ts` (`npm run test:npm-audit-actionable`)

## Why it exists

The dep-watch lane (`runNpmAudit` in `scripts/builder-worker.ts`, see [[security-agent]]) decides what goes into the dep-upgrade spec. That spec's machine verifier (`scripts/_check-npm-audit-actionable.ts`, `check:npm-audit-actionable`) decides when the build is done. Both read this predicate, so the lane can never file an advisory the verifier can't clear.

**Ground truth, 2026-10-14:** the 5 high glob-DoS advisories under `eslint-config-next@16.2.9` (fast-glob → micromatch → braces) had `fixAvailable: eslint-config-next@14.2.35`. That is a downgrade that peers on eslint 8 and breaks the build. The old check counted it as actionable, so the build `security-dep-upgrades-2026-10-*` could never pass its own verification and parked `needs_input` asking the CEO to pick a workaround. Before this change the dep-watch lane also filed no-fix advisories, which hit the same wedge.

## Exports

- `isActionableAdvisory(vuln, installedVersionOf)` returns true when severity is moderate/high/critical AND either `fixAvailable === true`, or `fixAvailable` is an object that is not a downgrade.
- `isDowngradeFix(fix, installedVersionOf)` returns true when `fix.version` is below the installed version of `fix.name`. An unknown installed version is never treated as a downgrade.
- `compareVersions(a, b)` compares dotted numeric versions and ignores prerelease tags.
- `nodeModulesVersionReader(repoDir)` returns a reader of `node_modules/<pkg>/package.json` versions.
- `ACTIONABLE_AUDIT_SEVERITIES` is the set of moderate, high and critical.

## Callers

- `scripts/_check-npm-audit-actionable.ts`, the dep-upgrade spec's `unit_test` verifier.
- `scripts/builder-worker.ts` `runNpmAudit`, which builds the dep-watch findings list.
