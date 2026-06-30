/**
 * pipeline-status — CLI for the read-only pipeline doctor ([[../src/lib/pipeline-doctor]]).
 *
 * The "what's stuck and WHY?" probe you run FIRST every session, instead of hand-writing ad-hoc SQL.
 * Pure diagnosis — it NEVER mutates (no status flips, no enqueues).
 *
 *   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/pipeline-status.ts            # stuck/anomalous only
 *   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/pipeline-status.ts --all      # + healthy
 *   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/pipeline-status.ts --slug X    # deep-dive one spec
 *   ... --since 6   # only count anomalies ≥ 6h old as stuck         ... --json   # raw PipelineDiagnosis JSON
 */
import "./_bootstrap";
import { diagnosePipeline } from "../src/lib/pipeline-doctor";
import type { PipelineDiagnosis, SpecDiagnosis, Severity } from "../src/lib/pipeline-doctor";

// ── tiny ANSI helpers (no dep) ───────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => c("1", s);
const dim = (s: string) => c("2", s);
const red = (s: string) => c("31", s);
const yellow = (s: string) => c("33", s);
const green = (s: string) => c("32", s);
const cyan = (s: string) => c("36", s);
const magenta = (s: string) => c("35", s);

const SEV_COLOR: Record<Severity, (s: string) => string> = {
  critical: (s) => c("1;41", s), // white-on-red
  high: red,
  medium: yellow,
  low: (s) => c("36", s),
  info: dim,
  none: green,
};
const SEV_TAG: Record<Severity, string> = { critical: "CRIT", high: "HIGH", medium: "MED ", low: "LOW ", info: "INFO", none: "OK  " };

function fmtAge(min: number | null): string {
  if (min == null) return "—";
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}h${min % 60 ? (min % 60) + "m" : ""}`;
  return `${Math.floor(min / 1440)}d${Math.floor((min % 1440) / 60)}h`;
}

function pad(s: string, n: number): string {
  // pad to visible width, ignoring ANSI
  const vis = s.replace(/\x1b\[[0-9;]*m/g, "");
  return s + " ".repeat(Math.max(0, n - vis.length));
}

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  const out: { all: boolean; slug?: string; since?: number; json: boolean } = { all: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--json") out.json = true;
    else if (a === "--slug") out.slug = argv[++i];
    else if (a.startsWith("--slug=")) out.slug = a.slice(7);
    else if (a === "--since") out.since = Number(argv[++i]);
    else if (a.startsWith("--since=")) out.since = Number(a.slice(8));
  }
  return out;
}

// ── compact table (default + --all) ──────────────────────────────────────────
function printTable(diag: PipelineDiagnosis) {
  // diag.specs is already scoped by the SDK (stuck + awaiting-human for the default view; everything under
  // --all). Render it as-is.
  const shown = diag.specs;

  // Header line: the one-line summary FIRST (it's the thing the CEO reads).
  const t = diag.totals;
  const sev = t.bySeverity;
  const sevBits = (["critical", "high", "medium", "low"] as Severity[])
    .filter((s) => sev[s] > 0)
    .map((s) => SEV_COLOR[s](`${sev[s]} ${s}`))
    .join(dim(" · "));
  console.log("");
  console.log(
    bold(`${t.total} specs`) +
      dim(" · ") +
      (t.stuck > 0 ? red(bold(`${t.stuck} stuck`)) : green(`0 stuck`)) +
      dim(" · ") +
      green(`${t.healthy} healthy`) +
      dim(" · ") +
      cyan(`${t.awaitingHuman} awaiting-human`) +
      (sevBits ? dim("  [") + sevBits + dim("]") : "") +
      dim(`  · build lane ${diag.lanes.activeBuilds}/${diag.lanes.buildPoolSize}`),
  );

  // The LOUD first-class check.
  if (diag.storedStatusViolations.length) {
    console.log("");
    console.log(SEV_COLOR.critical(` ⛔ STORED-STATUS-OVERRIDE VIOLATION × ${diag.storedStatusViolations.length} `) + " — raw specs.status holds a DERIVED value (override-only bug):");
    for (const v of diag.storedStatusViolations) {
      console.log("   " + red(v.slug) + dim(` raw='${v.rawStatus}' derived='${v.derivedStatus}'`));
    }
  } else {
    console.log(dim(`   stored-status-override check: 0 violations (clean)`));
  }

  if (!shown.length) {
    console.log("");
    console.log(green("   ✓ nothing stuck or anomalous."));
    console.log("");
    return;
  }

  console.log("");
  console.log(
    dim(
      pad("  SEV", 7) + pad("STATUS", 13) + pad("AGE", 7) + pad("SPEC", 46) + "WHY → ACTION",
    ),
  );
  console.log(dim("  " + "─".repeat(110)));
  for (const d of shown) {
    const primary = d.stuck.detector ? d.stuck : (d.detectors[0] ?? null);
    const sevName: Severity = primary ? (d.stuck.severity !== "none" ? d.stuck.severity : d.detectors[0]?.severity ?? "info") : "none";
    const tag = d.stuck.isStuck ? SEV_COLOR[sevName](SEV_TAG[sevName]) : d.detectors.length ? dim(SEV_TAG[sevName]) : green(SEV_TAG.none);
    const det = d.stuck.detector ?? d.detectors[0]?.name ?? "";
    const reason = (d.stuck.reason || d.detectors[0]?.reason || "").replace(/\s+/g, " ");
    const action = d.stuck.suggestedAction || d.detectors[0]?.suggestedAction || "";
    const why = det ? `${magenta(det)} ${dim("·")} ${reason}` : green("healthy");
    console.log(
      "  " +
        pad(tag, 7) +
        pad(statusColor(d.derivedStatus), 13) +
        pad(fmtAge(d.stuck.sinceMinutes ?? d.detectors[0]?.sinceMinutes ?? null), 7) +
        pad(cyan(d.slug.length > 44 ? d.slug.slice(0, 43) + "…" : d.slug), 46) +
        why,
    );
    if (action) console.log(pad("", 73) + dim("↳ " + action));
  }
  console.log("");
}

function statusColor(s: string): string {
  if (s === "in_testing") return yellow(s);
  if (s === "in_progress") return cyan(s);
  if (s === "shipped") return green(s);
  if (s === "deferred") return dim(s);
  if (s === "planned") return s;
  if (s === "in_review") return magenta(s);
  return s;
}

// ── deep dive (--slug) ───────────────────────────────────────────────────────
function printDeepDive(d: SpecDiagnosis) {
  console.log("");
  console.log(bold(cyan(d.slug)) + dim(`  —  ${d.title}`));
  console.log(
    "  status: " +
      statusColor(d.derivedStatus) +
      dim(` (raw override: ${d.rawStatus ?? "null"})`) +
      `  owner: ${d.owner ?? dim("—")}` +
      `  goal: ${d.goalSlug ?? dim("(one-off)")}` +
      (d.onGoalBranch ? green("  on-goal-branch") : "") +
      (d.critical ? red("  ★critical") : ""),
  );
  console.log("  parent: " + dim(d.parent ?? "—"));
  console.log("  lifecycle gate: " + bold(`${d.lifecycle.stage}`) + dim(` (${d.lifecycle.status})`));
  if (d.blockedByOpen.length) console.log("  " + yellow("blocked-by: ") + d.blockedByOpen.map((b) => `${b.slug}[${b.status}]`).join(", "));

  // phases
  console.log("");
  console.log(bold("  Phases:"));
  if (!d.phases.length) console.log(dim("    (one-shot — no phases)"));
  for (const p of d.phases) {
    const prov = [p.build_sha ? `build:${p.build_sha.slice(0, 7)}` : null, p.merge_sha ? `merge:${p.merge_sha.slice(0, 7)}` : null, p.pr ? `#${p.pr}` : null]
      .filter(Boolean)
      .join(" ");
    console.log(`    P${p.index} ${pad(statusColor(p.status), 13)} ${dim(prov || "(no provenance)")}  ${p.title}`);
  }

  // jobs
  console.log("");
  console.log(bold("  Jobs (latest per kind):"));
  if (!d.jobs.length) console.log(dim("    (none)"));
  for (const j of d.jobs) {
    console.log(
      `    ${pad(j.kind, 16)} ${pad(j.status, 15)} ${dim("age " + fmtAge(j.ageMinutes) + (j.heartbeatAgeMinutes != null ? " · hb " + fmtAge(j.heartbeatAgeMinutes) : ""))}` +
        (j.prNumber ? `  #${j.prNumber}` : "") +
        (j.branch ? dim("  " + j.branch) : ""),
    );
    if (j.needsAttentionClass) console.log(dim(`        needs_attention_class: ${j.needsAttentionClass}`));
    for (const p of j.pendingPrompts) console.log(yellow(`        ? ${p}`));
    if (j.error) console.log(red(`        error: ${j.error}`));
    if (j.logTail) console.log(dim(`        log: …${j.logTail.replace(/\s+/g, " ").slice(-200)}`));
  }

  // spec-test + security
  console.log("");
  console.log(bold("  Gates:"));
  if (d.specTest) {
    const s = d.specTest.summary;
    console.log(
      `    spec-test: ${verdictColor(d.specTest.verdict)} ${dim(`pass:${s.auto_pass} fail:${s.auto_fail} human:${s.needs_human} incon:${s.inconclusive}`)}` +
        (d.specTest.hasOpenRegression ? red("  OPEN-REGRESSION") : "") +
        dim(`  age ${fmtAge(d.specTest.ageMinutes)}${d.specTest.branch ? " · " + d.specTest.branch : ""}`),
    );
  } else console.log(dim("    spec-test: (no run)"));
  if (d.security) {
    console.log(
      `    security:  ` +
        (d.security.surfaced ? red("surfaced") : d.security.live ? yellow("live") : d.security.completedClean ? green("clean") : dim("none")),
    );
  } else console.log(dim("    security:  (no review)"));

  // detectors
  console.log("");
  console.log(bold("  Detectors:"));
  if (!d.detectors.length) console.log(green("    ✓ none matched — healthy."));
  for (const r of d.detectors) {
    console.log("    " + SEV_COLOR[r.severity](SEV_TAG[r.severity]) + " " + bold(r.name) + dim(`  (${fmtAge(r.sinceMinutes)})`));
    console.log(dim("      " + r.reason));
    console.log(dim("      ↳ " + r.suggestedAction));
  }
  console.log("");
  console.log(
    "  VERDICT: " +
      (d.stuck.isStuck ? SEV_COLOR[d.stuck.severity](`STUCK · ${d.stuck.detector} · ${fmtAge(d.stuck.sinceMinutes)}`) : green("not stuck")),
  );
  console.log("");
}

function verdictColor(v: string): string {
  if (v === "approved") return green(v);
  if (v === "issues" || v === "error") return red(v);
  if (v === "needs_human") return yellow(v);
  return v;
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const args = parseArgs(process.argv.slice(2));
  const diag = await diagnosePipeline({
    includeHealthy: args.all || !!args.slug,
    slug: args.slug,
    sinceHours: args.since,
  });

  if (args.json) {
    console.log(JSON.stringify(diag, null, 2));
    return;
  }

  if (args.slug) {
    const d = diag.specs.find((x) => x.slug === args.slug);
    if (!d) {
      console.log(red(`\n  spec '${args.slug}' is not on the board (folded/archived or unknown).\n`));
      return;
    }
    printDeepDive(d);
    return;
  }

  printTable(diag);
})().catch((e) => {
  console.error(red("pipeline-status failed:"), e);
  process.exit(1);
});
