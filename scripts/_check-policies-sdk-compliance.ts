/**
 * Static-analysis check: NO raw `.from('policies')` outside the policies SDK.
 *
 * `public.policies` is a two-halved rulebook — `internal_summary` + `rules` (what the AI obeys)
 * and `customer_summary` (what we publish on the help centre). Before this chokepoint six lib
 * files queried the table by hand and each repeated the active-and-not-superseded filter;
 * a wrong column name silently reads as empty and the AI proceeds without the rule (the
 * CLAUDE.md "database is the spec" failure mode). And because the two halves were never read
 * together, the published Order Cancellation policy shipped 'You can refuse the delivery when
 * it arrives' while three active policies say the opposite — a real customer was quoted the
 * wrong half on 2026-08-02.
 *
 * Every read/write MUST go through `src/lib/policies.ts` (the SDK chokepoint) —
 * `getPolicy` / `listActivePolicies` / `getInternalRules` / `updatePolicyText` /
 * `getPolicyCustomerFacing` / `insertDraftPolicy`. A raw `.from('policies')` in a route/lib/
 * script bypasses the SDK.
 *
 * SCAN SCOPE: every `.ts`/`.tsx` under `src/` + `scripts/` (excluding node_modules / .next /
 * dotdirs). The ONLY file allowed to issue raw `.from('policies')` is the SDK itself
 * (`src/lib/policies.ts`) and files on the `SANCTIONED_RAW_ACCESS` allow-list below. Every
 * entry on that list is debt — the goal is zero.
 *
 * Mirrors [[../scripts/_check-competitors-sdk-compliance.ts]] +
 * [[../scripts/_check-sonnet-prompts-sdk-compliance.ts]] (allow-list pattern). Wired into
 * `npm run check:policies-sdk-compliance` + chained into `predeploy`. Read-only; never
 * mutates.
 *
 * Run:  npx tsx scripts/_check-policies-sdk-compliance.ts            # exits 1 on any unexpected finding
 *       npx tsx scripts/_check-policies-sdk-compliance.ts --summary  # one-line-per-finding view
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** Repo root — this file lives at <root>/scripts/_check-policies-sdk-compliance.ts. */
const REPO_ROOT = join(__dirname, "..");

/** Table under guard. */
const TABLE = "policies";

/**
 * The sanctioned raw-access files. `src/lib/policies.ts` IS the SDK.
 * The compliance script itself is excluded — its docstrings reference the `.from('policies')`
 * pattern in prose, which the regex would flag on itself otherwise.
 */
const SDK_INTERNALS = new Set([
  "src/lib/policies.ts",
  "scripts/_check-policies-sdk-compliance.ts",
]);

/**
 * Sanctioned raw-access exceptions: (file, reason) entries. Each is a deliberate raw access
 * that is NOT (yet) routed through the SDK, with a written justification. Keep this list
 * minimal — every entry is debt. A finding is allowed iff its file matches an entry here.
 *
 * The two-halves-cannot-contradict spec ships the SDK chokepoint + migrates the five callers
 * named in its summary in Phase 1; the rest of the runtime lib layer + the storefront/admin
 * CRUD API + the data-authoring scripts stay on raw access with a written reason. A follow-up
 * spec drains the entries below; any NEW raw call still breaks the build.
 */
interface SanctionedEntry {
  file: string;
  reason: string;
}

const SANCTIONED_RAW_ACCESS: SanctionedEntry[] = [
  {
    file: "src/app/(storefront)/policies/[slug]/page.tsx",
    reason:
      "Storefront customer-facing policy page — reads `customer_summary` for public rendering. " +
      "The SDK exposes `getPolicyCustomerFacing` for exactly this shape; migrating is a mechanical " +
      "swap for a follow-up (the Phase 1 spec explicitly scopes to the five agent-facing callers).",
  },
  {
    file: "src/app/api/workspaces/[id]/policies/route.ts",
    reason:
      "Admin CRUD lane — lists every active policy for the workspace admin UI. `listActivePolicies` " +
      "already returns the full row shape; migration is a follow-up on the API surface (Phase 1 " +
      "scopes to the agent-facing lib callers).",
  },
  {
    file: "src/app/api/workspaces/[id]/policies/[slug]/route.ts",
    reason:
      "Admin CRUD lane — GET returns one active row, PUT updates in-place with a version bump. " +
      "`getPolicy` + `updatePolicyText` already cover this exactly; migration is a follow-up on " +
      "the API surface (Phase 1 scopes to the agent-facing lib callers).",
  },
  {
    file: "src/lib/ticket-analyzer.ts",
    reason:
      "Grader system prompt builder — reads `{slug,name,internal_summary}` for every active " +
      "policy. Same shape as `getInternalRules`; the sixth file the spec names alongside the five " +
      "migrated agent callers, deferred to a follow-up so Phase 1 stays scoped.",
  },
  {
    file: "src/lib/sonnet-prompt-auto-review.ts",
    reason:
      "Auto-reviewer read — SELECTs non-existent columns (`summary`, `internal_notes`, " +
      "`rules_json`) so the query already reads as empty; a follow-up rewrites it against the " +
      "SDK's real column names. Sanctioned for now because migrating without also fixing the " +
      "broken projection changes behaviour (the current code effectively noop-reads).",
  },
  {
    file: "scripts/builder-worker.ts",
    reason:
      "`loadActivePoliciesBlock` in Sol's ticket-handle brief loader — same shape as " +
      "`getInternalRules`. Runs in a top-level `claude -p` box session that imports very little " +
      "of `src/lib`; the migration will consolidate to the SDK in a follow-up alongside the " +
      "worker's other agent-brief loaders.",
  },
  {
    file: "scripts/seed-policies-v1.ts",
    reason:
      "Seed script — the initial-load ledger for the five canonical policies. Data-authoring " +
      "op that runs once per fresh workspace; a raw insert is appropriate because there is no " +
      "prior row to reconcile against.",
  },
  {
    file: "scripts/migrate-legal-policies.ts",
    reason:
      "One-off migration — moved legal policy text into the table. Data-authoring op with a " +
      "known-shape row set; not part of the runtime hot path.",
  },
  {
    file: "scripts/samantha-creamer-swap-and-policy.ts",
    reason:
      "Customer-remedy one-off — inserts a per-customer policy note tied to the Samantha " +
      "creamer swap incident. Data-authoring op, not runtime.",
  },
  {
    file: "scripts/fix-pause-policy-and-grader.ts",
    reason:
      "One-off apply-script — anchored-replacement edit of the live `pause` policy row. Follows " +
      "the `docs/brain/tables/policies.md` § Gotchas rule (targeted, idempotent, never re-seed).",
  },
  {
    file: "scripts/update-exchanges-allergy-escalate.ts",
    reason:
      "One-off apply-script — anchored-replacement edit of the live `exchanges` policy for the " +
      "allergy-safety escalation hardening (ticket 46471a76). Same pattern as fix-pause-policy.",
  },
  {
    file: "scripts/_probe-tree-thesis-3.ts",
    reason:
      "Read-only research probe — inspects policy timestamps for a tree-thesis analysis. Not a " +
      "runtime caller; the raw select stays on the probe.",
  },
];

const SANCTIONED_FILES = new Set(SANCTIONED_RAW_ACCESS.map(e => e.file));

/* ------------------------------------------------------------------------------------------------
 * Scope resolution.
 * --------------------------------------------------------------------------------------------- */

/** Recursively collect `*.ts(x)` files under a dir (skips node_modules / .next / dotdirs). */
function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTs(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Every file in scan scope (src/** + scripts/**), de-duped + sorted. */
function scanFiles(): string[] {
  const files = new Set<string>();
  for (const f of walkTs(join(REPO_ROOT, "src"))) files.add(f);
  for (const f of walkTs(join(REPO_ROOT, "scripts"))) files.add(f);
  return [...files].sort();
}

/* ------------------------------------------------------------------------------------------------
 * Finding the raw accesses. A single-line `.from("policies")` anchor is enough — the presence
 * of any such call outside the SDK is a violation whether it's a read or a write.
 * --------------------------------------------------------------------------------------------- */

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

const FROM_RE = new RegExp(`\\.from\\(\\s*["'\`]${TABLE}["'\`]\\s*\\)`, "g");

/** Scan one file's text for raw `.from('policies')` calls. Line/snippet-based; no verb classification. */
function findRawAccess(rel: string, text: string): Finding[] {
  const lines = text.split("\n");
  const out: Finding[] = [];
  let m: RegExpExecArray | null;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(text)) !== null) {
    const line = text.slice(0, m.index).split("\n").length; // 1-based
    out.push({ file: rel, line, snippet: lines[line - 1].trim().slice(0, 160) });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Main.
 * --------------------------------------------------------------------------------------------- */

function main() {
  const summary = process.argv.includes("--summary");
  const files = scanFiles();
  const findings: Finding[] = [];
  const sanctionedHits = new Set<string>();
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    if (SDK_INTERNALS.has(rel)) continue; // the SDK itself — sanctioned by definition
    const text = readFileSync(abs, "utf8");
    const hits = findRawAccess(rel, text);
    if (!hits.length) continue;
    if (SANCTIONED_FILES.has(rel)) {
      sanctionedHits.add(rel);
      continue;
    }
    findings.push(...hits);
  }

  // Every allowlist entry must actually still have a raw call; a stale entry is deadweight.
  const stale = [...SANCTIONED_FILES].filter(f => !sanctionedHits.has(f));

  if (summary) {
    console.log(
      `policies-SDK-compliance — ${files.length} file(s) scanned, ${findings.length} raw ` +
        `\`.from('${TABLE}')\` finding(s), ${sanctionedHits.size} allow-listed hit(s), ${stale.length} stale entry(s)`,
    );
    for (const f of findings) console.log(`  [VIOLATION] ${f.file}:${f.line}  ${f.snippet}`);
    for (const s of stale) console.log(`  [STALE ALLOWLIST] ${s}`);
  }

  if (findings.length > 0) {
    console.error(
      `\n❌ check-policies-sdk-compliance — ${findings.length} raw \`.from('${TABLE}')\` outside the SDK:\n`,
    );
    for (const f of findings) {
      console.error(`  • ${f.file}:${f.line}  →  ${f.snippet}`);
    }
    console.error(
      `\nRead/write access to \`public.${TABLE}\` goes through the SDK chokepoint\n` +
      `\`src/lib/policies.ts\` — \`getPolicy\` / \`listActivePolicies\` / \`getInternalRules\` /\n` +
      `\`updatePolicyText\` / \`getPolicyCustomerFacing\` / \`insertDraftPolicy\`. Active-and-not-\n` +
      `superseded filtering lives inside the SDK, not at each call site.\n\n` +
      `A hand-rolled query gets the wrong column name and silently reads as empty — the same failure\n` +
      `class that shipped the 2026-08-02 refuse-delivery contradiction (one half of a policy told\n` +
      `customers to refuse delivery, three other active policies said refused packages are 'not\n` +
      `eligible' for refund; a real customer lost her refund). Retarget this call to the SDK — see\n` +
      `CLAUDE.md § Local conventions and [[docs/brain/libraries/policies.md]].\n\n` +
      `If a genuine exception is unavoidable, add a written entry to \`SANCTIONED_RAW_ACCESS\` in\n` +
      `this file with the reason — every entry is debt and the goal is zero.\n`,
    );
    process.exit(1);
  }

  if (stale.length > 0) {
    console.error(
      `\n❌ check-policies-sdk-compliance — ${stale.length} stale entry(s) in SANCTIONED_RAW_ACCESS:\n`,
    );
    for (const s of stale) console.error(`  • ${s}  (no matching raw \`.from('${TABLE}')\` found)`);
    console.error(
      `\nRemove the stale entry(s) — the file no longer contains a raw access, so the sanction is dead code.\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-policies-sdk-compliance — ${files.length} file(s) scanned; 0 raw \`.from('${TABLE}')\` ` +
      `outside the SDK (${sanctionedHits.size} allow-listed).`,
  );
}

main();
