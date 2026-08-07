/**
 * check-npm-audit-actionable — the machine-runnable verifier for the dep-upgrade fix spec.
 *
 * Runs `npm audit --json` on the tree and exits NON-ZERO while any ACTIONABLE advisory remains —
 * where "actionable" is the same predicate the dep-watch cron uses to file findings: severity
 * ≥ moderate AND `fixAvailable` is truthy. Passes (exit 0) when the tree is clean of those.
 *
 * Called by the dep-upgrade spec's `unit_test` verification check
 * (security-dep-watch-authors-structured-and-never-ages-out Phase 1). The spec-check runner passes
 * a check when this script exits 0 — which only holds after the upgrade actually landed. A "not
 * fixed" tree fails LOUD with a per-package list, so the failure carries WHY (which package is
 * still vulnerable) not just a bare non-zero exit.
 *
 * `npm audit --json` exits non-zero WHEN vulnerabilities exist, so we parse the JSON regardless of
 * exit code (mirrors `runNpmAudit` in scripts/builder-worker.ts).
 *
 * Run:  npm run check:npm-audit-actionable
 *       npx tsx scripts/_check-npm-audit-actionable.ts
 */
import { execSync } from "child_process";

interface NpmAuditVuln {
  severity?: string;
  fixAvailable?: boolean | { name?: string; version?: string; isSemVerMajor?: boolean };
}
interface NpmAuditReport {
  vulnerabilities?: Record<string, NpmAuditVuln>;
  metadata?: { vulnerabilities?: Record<string, number> };
}

const ACTIONABLE_SEVERITIES: ReadonlySet<string> = new Set(["moderate", "high", "critical"]);

function runNpmAuditJson(): string {
  try {
    return execSync("npm audit --json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    // npm audit exits non-zero WHEN vulnerabilities exist; stdout still carries the JSON report.
    const stdout = (e as { stdout?: Buffer | string } | null)?.stdout;
    if (typeof stdout === "string") return stdout;
    if (stdout && typeof (stdout as Buffer).toString === "function") return (stdout as Buffer).toString("utf8");
    return "";
  }
}

function main(): void {
  const raw = runNpmAuditJson().trim();
  if (!raw) {
    console.error("check-npm-audit-actionable: npm audit --json produced no output");
    process.exit(2);
  }
  let report: NpmAuditReport;
  try {
    report = JSON.parse(raw) as NpmAuditReport;
  } catch {
    console.error("check-npm-audit-actionable: could not parse npm audit --json output");
    process.exit(2);
  }
  const actionable: { name: string; severity: string; fix: string }[] = [];
  for (const [name, v] of Object.entries(report.vulnerabilities || {})) {
    const severity = String(v.severity || "").toLowerCase();
    if (!ACTIONABLE_SEVERITIES.has(severity)) continue;
    const fix = v.fixAvailable;
    const hasFix = fix === true || (fix && typeof fix === "object");
    if (!hasFix) continue;
    const fixLabel =
      fix && typeof fix === "object"
        ? `${fix.name || name}@${fix.version || "?"}${fix.isSemVerMajor ? " (semver-major)" : ""}`
        : "available";
    actionable.push({ name, severity, fix: fixLabel });
  }
  if (actionable.length) {
    console.error(
      `\n❌ check-npm-audit-actionable — ${actionable.length} actionable (≥ moderate + fixAvailable) advisory(ies) remain:\n`,
    );
    for (const a of actionable) {
      console.error(`  • ${a.name} (${a.severity}) → upgrade ${a.fix}`);
    }
    console.error(
      `\nThe dep-upgrade fix hasn't landed yet — bump each dependency to its fixed version, then re-run.`,
    );
    process.exit(1);
  }
  const total = report.metadata?.vulnerabilities?.total ?? 0;
  console.log(
    `✓ check-npm-audit-actionable — 0 actionable (≥ moderate + fixAvailable) advisories (total tree count: ${total}).`,
  );
}

main();
