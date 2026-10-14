/**
 * npm-audit-actionable — the ONE predicate deciding whether an `npm audit --json` advisory is
 * actionable: severity ≥ moderate AND a real fix exists.
 *
 * Shared by the dep-watch lane (`runNpmAudit` in scripts/builder-worker.ts — decides what goes in
 * the dep-upgrade spec) and that spec's machine verifier (scripts/_check-npm-audit-actionable.ts —
 * decides when the build is done), so the two can never disagree.
 *
 * A "fix" that DOWNGRADES the target package is not a fix. npm's `fixAvailable` will name an older
 * major when the advisory range covers every current release (2026-10-14: the 5 high glob-DoS
 * advisories under eslint-config-next 16.x had `fixAvailable: eslint-config-next@14.2.35`, which
 * peers on eslint 8 and breaks the build). Counting that as actionable filed a spec whose own
 * verifier could never pass, and the build parked asking the CEO to pick a workaround.
 */
import { readFileSync } from "fs";
import { join } from "path";

export interface NpmAuditFix {
  name?: string;
  version?: string;
  isSemVerMajor?: boolean;
}

export interface NpmAuditVulnLike {
  severity?: string;
  fixAvailable?: boolean | NpmAuditFix;
}

export const ACTIONABLE_AUDIT_SEVERITIES: ReadonlySet<string> = new Set(["moderate", "high", "critical"]);

/** Compare dotted numeric versions (`16.2.9` vs `14.2.35`); prerelease tags are ignored.
 *  Returns <0, 0, >0. Unparseable input compares as equal. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^[^\d]*/, "").split(/[-+]/)[0].split(".").map((n) => Number.parseInt(n, 10));
  const pa = parse(a);
  const pb = parse(b);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when the suggested fix would install an OLDER version of its package than the tree has. */
export function isDowngradeFix(fix: NpmAuditFix, installedVersionOf: (pkg: string) => string | null): boolean {
  if (!fix.name || !fix.version) return false;
  const installed = installedVersionOf(fix.name);
  if (!installed) return false;
  return compareVersions(fix.version, installed) < 0;
}

/** Severity ≥ moderate AND a fix exists that is not a downgrade. */
export function isActionableAdvisory(
  v: NpmAuditVulnLike,
  installedVersionOf: (pkg: string) => string | null,
): boolean {
  const severity = String(v.severity || "").toLowerCase();
  if (!ACTIONABLE_AUDIT_SEVERITIES.has(severity)) return false;
  const fix = v.fixAvailable;
  if (fix === true) return true;
  if (!fix || typeof fix !== "object") return false;
  return !isDowngradeFix(fix, installedVersionOf);
}

/** Reads `<repoDir>/node_modules/<pkg>/package.json` version; null when absent/unreadable. */
export function nodeModulesVersionReader(repoDir: string): (pkg: string) => string | null {
  return (pkg) => {
    try {
      const v = JSON.parse(readFileSync(join(repoDir, "node_modules", pkg, "package.json"), "utf8")).version;
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  };
}
