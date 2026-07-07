/**
 * Static-analysis check: every JobKind in `scripts/builder-worker.ts`'s `Job.kind`
 * union has BOTH a claim lane (`p_kinds: ["<kind>"]`) AND a dispatcher entry
 * (`if (job.kind === "<kind>")`). The bug this catches — a kind in the union
 * with a runner + dispatcher entry but no claim lane — is invisible to `tsc` and
 * to every existing test, and is exactly the "spec-review queue never drained"
 * regression this script exists to prevent (see vale-spec-review-restore-worker-claim-lane).
 *
 * Wired into the `predeploy` (`npm run check:worker-lanes`) so a regression fails
 * CI red, not silently.
 *
 * Read-only by construction: this script reads the source, prints a diff, and
 * exits non-zero on a mismatch. It never mutates state.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const WORKER_PATH = resolve(__dirname, "builder-worker.ts");

// Kinds the worker never CLAIMS by direct poll — typically because they ride a
// multi-kind lane that already lists them. The exemption requires a one-line
// comment naming the lane that DOES claim it. Today every kind has a direct or
// shared lane; this set is empty by audit.
//
// Note: shared lanes (e.g. `p_kinds: ["fold", "goal-fold"]`) cover ALL their
// listed kinds — the check's lane-set extraction handles that, so kinds on a
// shared lane do NOT need to be exempted here.
const NO_LANE_BY_DESIGN: Record<string, string> = {
  // (example) "kind-x": "claimed indirectly by the build/plan lane via X",
};

// Kinds DISPATCHED by fall-through (no explicit `if (job.kind === "...")` line).
// `build` is the implicit default in `dispatchJob` — after every other kind's
// `if` block returns, the function continues into the build flow. Marked here so
// the check recognizes it without forcing a 400-line refactor.
const DISPATCH_BY_FALLTHROUGH: Record<string, string> = {
  build: "implicit default in dispatchJob — the build flow is the function tail after every explicit `if (job.kind === ...)` branch",
};

function fail(msg: string): never {
  console.error(`\n❌ check-worker-lanes — ${msg}\n`);
  process.exit(1);
}

function readWorker(): string {
  try {
    return readFileSync(WORKER_PATH, "utf8");
  } catch (e) {
    fail(`could not read ${WORKER_PATH}: ${(e as Error).message}`);
  }
}

function extractKindUnion(src: string): Set<string> {
  // Match the `kind: "..." | "..." | ... ;` line in the Job interface. Tolerant
  // of whitespace + line breaks within the union.
  const m = /\n\s*kind:\s*((?:"[a-z0-9_-]+"\s*\|\s*)*"[a-z0-9_-]+")\s*;/i.exec(src);
  if (!m) fail("could not locate the `kind: \"...\" | ...` union on the Job interface in builder-worker.ts");
  const literals = [...m[1].matchAll(/"([a-z0-9_-]+)"/gi)].map((x) => x[1]);
  if (literals.length === 0) fail("Job.kind union parsed but had no literals");
  return new Set(literals);
}

function extractClaimedKinds(src: string): Set<string> {
  // Match every `p_kinds: ["<kind>", "<kind>", ...]` site. Multi-kind lanes
  // (e.g. `["fold", "goal-fold"]`, `["build", "plan"]`) cover all listed kinds.
  const out = new Set<string>();
  const re = /p_kinds:\s*\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    for (const k of m[1].matchAll(/"([a-z0-9_-]+)"/gi)) out.add(k[1]);
  }
  return out;
}

function extractDispatchedKinds(src: string): Set<string> {
  const out = new Set<string>();
  const re = /if\s*\(\s*job\.kind\s*===\s*"([a-z0-9_-]+)"\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

// worker-self-update-force-on-unknown-queued-kind Phase 1: `KNOWN_JOB_KINDS` must mirror the union
// so the poll-loop probe can name a truly-unknown kind. A missing entry here would silently break
// the force-override for the new kind (busy/behind<25 defer would keep re-firing and the new lane
// would stay non-drainable). Parses the Set literal in builder-worker.ts.
function extractKnownJobKinds(src: string): Set<string> {
  const m = /const\s+KNOWN_JOB_KINDS:[^=]*=\s*new\s+Set<Job\["kind"\]>\(\[([^\]]+)\]\)/.exec(src);
  if (!m) fail("could not locate `const KNOWN_JOB_KINDS: ... = new Set<Job[\"kind\"]>([...])` in builder-worker.ts");
  const literals = [...m[1].matchAll(/"([a-z0-9_-]+)"/gi)].map((x) => x[1]);
  if (literals.length === 0) fail("KNOWN_JOB_KINDS parsed but had no literals");
  return new Set(literals);
}

function summary(label: string, kinds: Iterable<string>): string {
  const arr = [...kinds].sort();
  return `${label} (${arr.length}): ${arr.join(", ")}`;
}

function main() {
  const src = readWorker();
  const union = extractKindUnion(src);
  const claimed = extractClaimedKinds(src);
  const dispatched = extractDispatchedKinds(src);
  const known = extractKnownJobKinds(src);

  const errors: string[] = [];

  // 1. Every kind in the union has a claim lane (or a NO_LANE_BY_DESIGN exemption).
  for (const kind of union) {
    if (claimed.has(kind)) continue;
    if (kind in NO_LANE_BY_DESIGN) continue;
    errors.push(
      `kind "${kind}" is in the Job.kind union AND has a dispatcher/runner, but NO worker claim lane ` +
      `(no \`p_kinds: ["${kind}"]\` in builder-worker.ts). The cron / event will enqueue a job for this kind ` +
      `and it will sit unclaimed in the queue forever. Either add the claim lane (mirror an existing supervisory ` +
      `lane like spec-review or spec-test) OR add "${kind}" to NO_LANE_BY_DESIGN in this script with a one-line ` +
      `comment naming the lane that DOES claim it.`,
    );
  }

  // 2. Every kind in the union has a dispatcher entry (or a fall-through marker).
  for (const kind of union) {
    if (dispatched.has(kind)) continue;
    if (kind in DISPATCH_BY_FALLTHROUGH) continue;
    errors.push(
      `kind "${kind}" is in the Job.kind union, but has NO dispatcher entry ` +
      `(no \`if (job.kind === "${kind}")\` in builder-worker.ts). A claimed job of this kind will fall ` +
      `into the build flow and either build-as-a-spec or crash. Either add the dispatcher entry OR add ` +
      `"${kind}" to DISPATCH_BY_FALLTHROUGH with a comment explaining the fall-through path.`,
    );
  }

  // 3. Every claimed/dispatched kind is in the union (defends against typos in
  //    a `p_kinds:` array or an `if (job.kind === ...)` line).
  for (const kind of claimed) {
    if (!union.has(kind)) {
      errors.push(`claim lane references "${kind}" but it is NOT in the Job.kind union — typo?`);
    }
  }
  for (const kind of dispatched) {
    if (!union.has(kind)) {
      errors.push(`dispatcher entry references "${kind}" but it is NOT in the Job.kind union — typo?`);
    }
  }

  // 4. Audit hygiene: every NO_LANE_BY_DESIGN entry must be a real kind (else the
  //    exemption is a stale rule masking nothing).
  for (const kind of Object.keys(NO_LANE_BY_DESIGN)) {
    if (!union.has(kind)) {
      errors.push(`NO_LANE_BY_DESIGN exempts "${kind}" but that kind is NOT in the Job.kind union — stale entry, remove it.`);
    }
  }
  for (const kind of Object.keys(DISPATCH_BY_FALLTHROUGH)) {
    if (!union.has(kind)) {
      errors.push(`DISPATCH_BY_FALLTHROUGH exempts "${kind}" but that kind is NOT in the Job.kind union — stale entry, remove it.`);
    }
  }

  // 5. KNOWN_JOB_KINDS mirrors the union (worker-self-update-force-on-unknown-queued-kind Phase 1).
  //    A missing entry silently breaks the force-override: a queued job of the missing kind would be
  //    treated as "known" and the busy/behind<25 defer would keep stranding the new lane.
  for (const kind of union) {
    if (!known.has(kind)) {
      errors.push(
        `kind "${kind}" is in the Job.kind union but NOT in KNOWN_JOB_KINDS in builder-worker.ts. ` +
        `Add it there so the poll-loop unknown-queued-kind probe can force a self-update when this ` +
        `kind is queued on an older running worker.`,
      );
    }
  }
  for (const kind of known) {
    if (!union.has(kind)) {
      errors.push(`KNOWN_JOB_KINDS lists "${kind}" but it is NOT in the Job.kind union — stale entry, remove it.`);
    }
  }

  if (errors.length > 0) {
    console.error(`\n❌ check-worker-lanes — ${errors.length} issue(s) detected:\n`);
    for (const e of errors) console.error(`  • ${e}\n`);
    console.error(`\nSnapshot:`);
    console.error(`  ${summary("union    ", union)}`);
    console.error(`  ${summary("claimed  ", claimed)}`);
    console.error(`  ${summary("dispatched", dispatched)}`);
    console.error(`  ${summary("known    ", known)}`);
    process.exit(1);
  }

  console.log(`✓ check-worker-lanes — ${union.size} job kind(s) in union; every kind has a claim lane and a dispatcher entry.`);
  console.log(`  ${summary("union    ", union)}`);
}

main();
