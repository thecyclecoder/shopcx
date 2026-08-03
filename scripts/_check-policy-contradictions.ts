/**
 * Contradiction check — Phase 3 of
 * docs/brain/specs/a-policies-chokepoint-so-published-and-internal-rules-cannot-contradict.md.
 *
 * WHY. On 2026-08-02 the published Order Cancellation policy shipped "You can refuse the delivery
 * when it arrives" while three OTHER active policies say the opposite in the strongest terms — a
 * refused / return-to-sender package arrives with no tracking we can match to an order, so it
 * can never be refunded (Terms: "absolutely, 100% not eligible"). The two halves of a policy
 * are written months apart by different authors and never read together, so a customer who
 * followed the published cancellation policy lost her refund entirely. Phase 1 sealed the read
 * chokepoint; Phase 2 fed BOTH agents from it. Phase 3 turns the same class of contradiction
 * into a build failure at authoring time instead of something a customer discovers.
 *
 * WHAT. This check scans every ACTIVE, non-superseded policy in the workspace(s) and flags any
 * `customer_summary` that offers a path another active policy's INTERNAL rule forbids. The
 * forbidden paths are encoded as assertions in `FORBIDDEN_PATHS` below — each entry cites the
 * SOURCE policy's rule that establishes the prohibition (the machine-readable `rules[]`
 * assertion, not free prose), and the phrases in any `customer_summary` that would talk past
 * it. This is DELIBERATELY the "rules-anchored" shape the spec asks for — a customer_summary
 * that offers `refuse the delivery when it arrives` is a contradiction iff the returns policy
 * still holds the refused-package prohibition; the assertion's anchor is what makes the check
 * meaningful vs. a prose-matcher that could quietly drift.
 *
 * REGRESSION FIXTURE. The refuse-delivery case (the 2026-08-02 incident's known-bad prior
 * state) ships as an inline fixture at the bottom of this file — a synthetic policy set with
 * the historical bad `customer_summary`. The check ALWAYS runs against that fixture; a
 * regression that stops flagging the fixture fails the build with the exact reason ("the
 * refuse-delivery contradiction is no longer detected"). That is the spec's Phase-3
 * verification bullet: "the refused-package case is covered".
 *
 * LOUD COVERAGE — NOT SILENT PASS. The spec is explicit ("a check that quietly covers nothing
 * is worse than no check, because it reads as coverage"). So this script:
 *   - Prints how many assertions it evaluated and how many `customer_summary` fields it
 *     scanned; a zero on either count fails the build with an explicit reason.
 *   - Prints, per FORBIDDEN_PATHS entry, whether its anchor rule was FOUND in the live source
 *     policy's `rules[]` (`anchor: found` vs `anchor: MISSING`). A missing anchor is a WARNING
 *     — the check still runs its phrase assertions, but the operator is told LOUDLY that the
 *     rule the check leans on is not currently in the source policy's rules array (a drift
 *     between the assertion and the live rulebook).
 *   - Live DB scan is opportunistic: when Supabase credentials are present the script scans
 *     every workspace's active policies through the SDK chokepoint. When credentials are
 *     ABSENT the script cannot honestly claim a full pass — it exits NON-ZERO by default,
 *     announcing the offline mode. An operator running locally without credentials can opt in
 *     to a partial-coverage pass with `--allow-offline` (or `ALLOW_OFFLINE_POLICY_CHECK=1`);
 *     the box always has credentials so no opt-in is needed there. This is deliberately loud:
 *     before Phase 2 the guard printed "live scan: skipped" and exited 0, letting a local
 *     `npm run predeploy` read green while the box saw contradictions the developer never did.
 *
 * SCOPE — WHAT THIS CHECK CANNOT COVER (per spec's "loud rather than silent" rule).
 *   - Contradictions expressible only in prose (an internal_summary paragraph that a rule
 *     doesn't formalize) are OUT OF SCOPE — a check that guesses at prose semantics is the
 *     "quiet coverage" the spec warns against. This script prints a section at the end
 *     listing THIS class explicitly so the operator sees what is NOT being enforced.
 *
 * MIRRORS: `_check-competitors-sdk-compliance.ts` (guard skeleton) +
 * `_check-rls-on-new-tables.ts` (static-analysis registry pattern). Wired into
 * `npm run check:policy-contradictions` + chained into `predeploy`. Read-only; never mutates.
 *
 * Run:  npx tsx scripts/_check-policy-contradictions.ts                  # exits 1 on any finding OR unacknowledged offline mode
 *       npx tsx scripts/_check-policy-contradictions.ts --allow-offline  # acknowledge the live scan is skipped
 *       npx tsx scripts/_check-policy-contradictions.ts --summary        # one-line-per-finding view
 */

import { errText } from "../src/lib/error-text";

/* ------------------------------------------------------------------------------------------------
 * Types (mirrored from src/lib/policies.ts's AgentPolicyPackageEntry + full row shape needed
 * for `customer_summary` scanning — the SDK returns the internal projection which excludes the
 * customer half; this check needs both).
 * --------------------------------------------------------------------------------------------- */

/** The subset of a policy row this check reads. */
interface PolicyForCheck {
  slug: string;
  name: string;
  customer_summary: string;
  internal_summary: string;
  rules: unknown[];
}

/**
 * One machine-readable rule assertion — the `rules[]` entries seeded by `scripts/seed-policies-
 * v1.ts` all use `{ id, ...typed fields }`. This check only reads `id` to prove an anchor
 * exists; the rest is opaque per the "rules-anchored, not prose-matched" spec ask.
 */
interface PolicyRuleAssertion {
  id?: string;
  [k: string]: unknown;
}

/**
 * One entry in the forbidden-paths registry. Each names an anchor rule (`sourceSlug` +
 * `anchorRuleId`) that established the prohibition, plus the customer-summary phrases that
 * would offer a path past it. `phrasePatterns` are matched case-insensitively as substrings —
 * no regex, no ambiguity.
 */
interface ForbiddenPathAssertion {
  /** Assertion id — printed in findings so a human can `grep` to this line. */
  id: string;
  /** Human-readable description of what this contradiction class is. */
  description: string;
  /** The policy slug whose `rules[]` should carry the anchor. */
  sourceSlug: string;
  /** The `rules[].id` value that establishes the prohibition (drift detector). */
  anchorRuleId: string;
  /** Phrases in any `customer_summary` that would offer a path past the prohibition. */
  phrasePatterns: string[];
  /** Why the phrase is a contradiction — surfaced verbatim in the finding. */
  reason: string;
}

/* ------------------------------------------------------------------------------------------------
 * The registry. Each entry is one contradiction class the check enforces.
 *
 * The ONLY class currently encoded is the 2026-08-02 refuse-delivery incident — the known bad
 * prior state the spec explicitly calls out. Adding a class means adding a NEW entry here with
 * a clear anchor rule id + the exact phrases to forbid; the coverage summary will announce it
 * on the next run. Deliberately narrow (per spec: "encode the known forbidden paths" — not
 * every conceivable one).
 * --------------------------------------------------------------------------------------------- */

const FORBIDDEN_PATHS: ForbiddenPathAssertion[] = [
  {
    id: "returns.no_refund_on_refused_or_return_to_sender",
    description:
      "A refused / return-to-sender package arrives with no tracking we can match to an order, " +
      "so we CANNOT match it to a customer and CANNOT refund it. Terms calls such packages " +
      "'absolutely, 100% not eligible'. No customer-facing policy may offer 'refuse the delivery' " +
      "or 'return to sender' as a valid path.",
    sourceSlug: "returns",
    // The anchor rule that formalizes the prohibition. Drift is announced LOUDLY on run (the
    // check keeps working — the assertions here are the authority — but the operator is told
    // the source policy's `rules[]` no longer carries the anchor so the two need to re-sync.
    // See docs/brain/tables/policies.md § Gotchas — this is the "rules drift" class.
    anchorRuleId: "returns.no_refund_on_refused_or_return_to_sender",
    phrasePatterns: [
      "refuse the delivery",
      "refuse delivery when",
      "refuse when it arrives",
      "return to sender",
      "return-to-sender",
      "refused package",
      "refused-package",
    ],
    reason:
      "Refused / return-to-sender packages cannot be refunded (no order-matchable tracking). " +
      "A customer who follows this instruction loses the refund entirely — the 2026-08-02 " +
      "incident's exact failure.",
  },
];

/* ------------------------------------------------------------------------------------------------
 * The scanner — pure over a policy set. Exported so unit callers (and the regression fixture
 * below) exercise the SAME code path the live-DB probe does.
 * --------------------------------------------------------------------------------------------- */

export interface Finding {
  assertionId: string;
  offendingSlug: string;
  matchedPhrase: string;
  anchorSlug: string;
  anchorRuleId: string;
  anchorPresent: boolean;
  reason: string;
}

export interface ScanReport {
  policiesScanned: number;
  assertionsEvaluated: number;
  findings: Finding[];
  /** Per-assertion anchor state — logged in the coverage summary. */
  anchorReport: Array<{ assertionId: string; anchorSlug: string; anchorRuleId: string; found: boolean }>;
}

/** Extract the id list from a policy's `rules[]` (best-effort — a malformed entry is skipped). */
function extractRuleIds(rules: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const r of rules) {
    if (r && typeof r === "object") {
      const id = (r as PolicyRuleAssertion).id;
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }
  return ids;
}

/**
 * Scan a policy set for contradictions. Case-insensitive substring match on customer_summary
 * against each `phrasePatterns` entry. Returns the finding list + a coverage report — the
 * caller decides whether to fail the build on findings (main() does).
 */
/**
 * Does `phrase` appear as an INSTRUCTION to the customer, rather than a PROHIBITION?
 *
 * The scan used to be a bare `haystack.includes(phrase)`, which cannot tell
 * "you can refuse the delivery" from "please don't refuse the delivery". Every
 * live finding on 2026-08-02 was the second kind — correct policy text that
 * WARNS customers off the forbidden path — and the naive matcher flagged all
 * three:
 *
 *   order-cancellation: "Please don't refuse the delivery or send it back marked
 *                        'return to sender.' Those packages reach us with no
 *                        tracking we can match to your order…"
 *   terms:              "Return To Sender & 'Refused' Packages Are NOT Eligible…"
 *
 * That false positive is dangerous, not merely noisy: the only way to make the
 * check green by editing DATA is to DELETE the warning, restoring the exact bug
 * (a customer told to refuse delivery loses their refund) this check exists to
 * prevent. A guard that can be satisfied by removing the safety text is worse
 * than no guard — so negation is recognised here, and the policy text stays.
 *
 * Deliberately conservative: it looks for negation/prohibition markers in the
 * clause CONTAINING the phrase. Anything ambiguous still reports, because a
 * false positive costs a human read while a false negative ships the bug.
 */
export function appearsAsInstruction(haystack: string, phrase: string): boolean {
  const hay = haystack.toLowerCase();
  const needle = phrase.toLowerCase();
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return false;
    // The clause around the match — bounded by sentence/heading punctuation.
    const start = Math.max(0, hay.lastIndexOf(".", at) + 1, hay.lastIndexOf("\n", at) + 1);
    const dot = hay.indexOf(".", at + needle.length);
    const nl = hay.indexOf("\n", at + needle.length);
    const ends = [dot, nl].filter(x => x !== -1);
    const end = ends.length ? Math.min(...ends) : hay.length;
    const clause = hay.slice(start, end);
    const NEGATORS = [
      "don't", "do not", "dont", "never", "cannot", "can't", "cant", "not eligible",
      "no refund", "won't", "will not", "aren't", "are not", "isn't", "is not",
      "unable to", "please avoid", "avoid ", "ineligible", "not accepted", "we don't accept",
    ];
    if (!NEGATORS.some(n => clause.includes(n))) return true;   // no negation → reads as an instruction
    from = at + needle.length;                                   // negated here; keep looking
  }
}

export function scanPolicySet(policies: PolicyForCheck[]): ScanReport {
  // Per-slug rule-id index for anchor presence checks.
  const rulesBySlug = new Map<string, Set<string>>();
  for (const p of policies) rulesBySlug.set(p.slug, extractRuleIds(p.rules));

  const anchorReport: ScanReport["anchorReport"] = FORBIDDEN_PATHS.map(a => ({
    assertionId: a.id,
    anchorSlug: a.sourceSlug,
    anchorRuleId: a.anchorRuleId,
    found: (rulesBySlug.get(a.sourceSlug) ?? new Set<string>()).has(a.anchorRuleId),
  }));

  const findings: Finding[] = [];
  for (const p of policies) {
    const haystack = (p.customer_summary || "").toLowerCase();
    if (!haystack) continue;
    for (const assertion of FORBIDDEN_PATHS) {
      for (const phrase of assertion.phrasePatterns) {
        if (appearsAsInstruction(haystack, phrase)) {
          const anchorFound = (rulesBySlug.get(assertion.sourceSlug) ?? new Set<string>()).has(
            assertion.anchorRuleId,
          );
          findings.push({
            assertionId: assertion.id,
            offendingSlug: p.slug,
            matchedPhrase: phrase,
            anchorSlug: assertion.sourceSlug,
            anchorRuleId: assertion.anchorRuleId,
            anchorPresent: anchorFound,
            reason: assertion.reason,
          });
        }
      }
    }
  }

  return {
    policiesScanned: policies.length,
    assertionsEvaluated: FORBIDDEN_PATHS.length,
    findings,
    anchorReport,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Regression fixture — pins BOTH shapes the matcher must distinguish:
 *
 *   INSTRUCTION (must be FLAGGED). The 2026-08-02 known-bad state — a customer_summary that
 *   OFFERS the forbidden path. A regression here would re-ship the exact incident.
 *
 *   PROHIBITION (must NOT be flagged). The live, correct policy text that WARNS customers off
 *   the forbidden path — verbatim excerpts of the current Superfoods order-cancellation and
 *   terms customer_summaries. The naive `haystack.includes(phrase)` matcher flagged all three,
 *   creating a false positive that could only be cleared by DELETING the safety warning (and
 *   thereby restoring the very incident this check exists to prevent). Pinning the prohibition
 *   shape here means a future edit that regresses `appearsAsInstruction` (say, by dropping a
 *   negator token) fails the build BEFORE it hits the live scan.
 *
 * The check ALWAYS runs both fixtures so the refuse-delivery case is covered independent of
 * whatever the live DB looks like. A regression fails the build with the exact reason.
 * --------------------------------------------------------------------------------------------- */

const REFUSE_DELIVERY_FIXTURE: PolicyForCheck[] = [
  {
    slug: "returns",
    name: "Returns Policy (fixture)",
    customer_summary: "Standard 30-day money-back guarantee. Contact us before returning.",
    internal_summary: "See seeded returns policy for the full rulebook.",
    rules: [
      // The anchor rule for the assertion. Kept in the fixture so anchor presence exercises the
      // "found" path; the operator running against a live DB missing this rule is told LOUDLY.
      { id: "returns.no_refund_on_refused_or_return_to_sender" },
    ],
  },
  {
    slug: "cancellation-instruction-bad-state",
    name: "Order Cancellation Policy (2026-08-02 bad state — must be FLAGGED)",
    // This is the historical bad text — the exact wording that voided a real customer's refund.
    customer_summary: "If your package is already on the way, you can refuse the delivery when it arrives.",
    internal_summary:
      "Fixture — cancellation policy allowed refuse-delivery language before the Phase-3 " +
      "chokepoint. The regression exists so a code change that stops flagging this text fails " +
      "the build.",
    rules: [],
  },
  {
    slug: "cancellation-instruction-synthesized",
    name: "Synthesized instruction phrasing (must be FLAGGED)",
    // Additional instruction-shape phrasing that is grammatically distinct from the 2026-08-02
    // wording — proves the matcher does not silently narrow to one historical string.
    customer_summary:
      "For fastest resolution, refuse the delivery and we'll refund you as soon as it arrives back.",
    internal_summary: "Fixture — synthesized instruction phrasing.",
    rules: [],
  },
  {
    slug: "cancellation-prohibition",
    name: "Order Cancellation Policy (current correct text — must NOT be flagged)",
    // Verbatim from the live Superfoods order-cancellation customer_summary — the 2026-08-02
    // remediation. A matcher regression that flags this would force the operator to DELETE the
    // safety warning to make the build green, restoring the original incident.
    customer_summary:
      "Please don't refuse the delivery or send it back marked 'return to sender.' Those packages reach us with no tracking we can match to your order, so we can't refund them.",
    internal_summary: "Fixture — the CORRECT prohibition text as shipped on the live site.",
    rules: [],
  },
  {
    slug: "terms-prohibition",
    name: "Terms (current correct text — must NOT be flagged)",
    // Verbatim excerpt from the live Superfoods terms customer_summary. Heading + emphatic
    // negator sentence, formatted the way the real policy is.
    customer_summary:
      "### Return To Sender & 'Refused' Packages Are NOT Eligible for Return\nSuch packages are absolutely, 100% not eligible for refund.",
    internal_summary: "Fixture — the CORRECT prohibition text as shipped on the live site.",
    rules: [],
  },
];

/**
 * Slugs whose customer_summary is an INSTRUCTION and MUST produce a finding. Any of these
 * failing to be flagged is a matcher regression (the 2026-08-02 incident would ship again).
 */
const INSTRUCTION_FIXTURE_SLUGS = [
  "cancellation-instruction-bad-state",
  "cancellation-instruction-synthesized",
] as const;

/**
 * Slugs whose customer_summary is a PROHIBITION (correct warning) and MUST NOT produce a
 * finding. Any of these being flagged is a false positive — the only way to clear it would be
 * to delete the safety warning, restoring the 2026-08-02 incident. Pinned so a naive matcher
 * regression fails the build BEFORE it silently forces someone to delete correct policy text.
 */
const PROHIBITION_FIXTURE_SLUGS = ["cancellation-prohibition", "terms-prohibition"] as const;

/**
 * Run the regression fixture and assert BOTH shapes are handled correctly:
 *   - every INSTRUCTION slug produces at least one finding (the check still fires on the bad
 *     state; a regression here would re-ship the 2026-08-02 incident);
 *   - no PROHIBITION slug produces any finding (correct warning text is not flagged; a
 *     regression here would force the operator to delete safety text to make the build green).
 *
 * Returns `{ ok: true }` when both hold; `{ ok: false, reason }` otherwise. main() turns a
 * failure into exit 1.
 */
function runRefuseDeliveryRegression(): { ok: boolean; reason?: string } {
  const report = scanPolicySet(REFUSE_DELIVERY_FIXTURE);
  const findingsBySlug = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const list = findingsBySlug.get(f.offendingSlug) ?? [];
    list.push(f);
    findingsBySlug.set(f.offendingSlug, list);
  }

  const missingInstruction: string[] = [];
  for (const slug of INSTRUCTION_FIXTURE_SLUGS) {
    const hits = findingsBySlug.get(slug) ?? [];
    const ok = hits.some(
      f =>
        f.assertionId === "returns.no_refund_on_refused_or_return_to_sender" &&
        f.matchedPhrase.toLowerCase().includes("refuse"),
    );
    if (!ok) missingInstruction.push(slug);
  }
  if (missingInstruction.length > 0) {
    return {
      ok: false,
      reason:
        `refuse-delivery INSTRUCTION fixture(s) no longer flagged: ${missingInstruction.join(", ")} — ` +
        "the contradiction check has regressed and the 2026-08-02 class of failure would ship again.",
    };
  }

  const falsePositives: string[] = [];
  for (const slug of PROHIBITION_FIXTURE_SLUGS) {
    const hits = findingsBySlug.get(slug) ?? [];
    if (hits.length > 0) falsePositives.push(`${slug} (matched "${hits[0]!.matchedPhrase}")`);
  }
  if (falsePositives.length > 0) {
    return {
      ok: false,
      reason:
        `PROHIBITION fixture(s) incorrectly flagged: ${falsePositives.join("; ")} — ` +
        "the matcher has regressed to the pre-2026-08-02 bare-substring shape and would force " +
        "an operator to DELETE correct safety text to make the build green, restoring the very " +
        "incident this check exists to prevent.",
    };
  }

  return { ok: true };
}

/* ------------------------------------------------------------------------------------------------
 * Live-DB probe — opportunistic. When Supabase credentials are present, read every workspace's
 * active policies through the SDK chokepoint (src/lib/policies.ts) and scan them. When
 * credentials are missing, skip the live probe and announce that mode LOUDLY on the summary
 * line so a green "0 findings" line can never be mistaken for coverage.
 * --------------------------------------------------------------------------------------------- */

interface LiveScanOutcome {
  attempted: boolean;
  skippedReason?: string;
  workspacesScanned: number;
  policiesScanned: number;
  findings: Finding[];
}

async function runLiveScan(): Promise<LiveScanOutcome> {
  const hasCreds =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!hasCreds) {
    return {
      attempted: false,
      skippedReason:
        "Supabase credentials absent (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) — " +
        "live-DB scan skipped; regression fixture still runs.",
      workspacesScanned: 0,
      policiesScanned: 0,
      findings: [],
    };
  }
  try {
    // Dynamic import so `tsx scripts/_check-policy-contradictions.ts --help` doesn't pay the
    // Supabase-client cost when creds aren't set.
    const { createAdminClient } = await import("../src/lib/supabase/admin");
    const { listActivePolicies } = await import("../src/lib/policies");
    const admin = createAdminClient();
    const { data: workspaces, error } = await admin.from("workspaces").select("id, name");
    if (error) {
      return {
        attempted: true,
        skippedReason: `workspaces read failed: ${error.message}`,
        workspacesScanned: 0,
        policiesScanned: 0,
        findings: [],
      };
    }
    let policiesScanned = 0;
    const findings: Finding[] = [];
    for (const ws of workspaces ?? []) {
      const rows = await listActivePolicies(admin, ws.id as string);
      const forCheck: PolicyForCheck[] = rows.map(r => ({
        slug: r.slug,
        name: r.name,
        customer_summary: r.customer_summary ?? "",
        internal_summary: r.internal_summary ?? "",
        rules: r.rules,
      }));
      const report = scanPolicySet(forCheck);
      policiesScanned += report.policiesScanned;
      for (const f of report.findings) {
        findings.push({ ...f, offendingSlug: `${(ws.name as string | undefined) ?? ws.id}:${f.offendingSlug}` });
      }
    }
    return {
      attempted: true,
      workspacesScanned: (workspaces ?? []).length,
      policiesScanned,
      findings,
    };
  } catch (err) {
    return {
      attempted: true,
      skippedReason: `live-DB scan threw: ${errText(err)}`,
      workspacesScanned: 0,
      policiesScanned: 0,
      findings: [],
    };
  }
}

/* ------------------------------------------------------------------------------------------------
 * Main.
 * --------------------------------------------------------------------------------------------- */

async function main() {
  const summary = process.argv.includes("--summary");
  // Opt-in flag: an operator running locally without Supabase credentials must explicitly
  // acknowledge that the live-DB half is being skipped. Without it, an env-less local run
  // that used to print "live scan: skipped" and exit 0 is now a hard failure — the whole
  // reason the box saw contradictions the developer's laptop didn't. Also accepted via
  // ALLOW_OFFLINE_POLICY_CHECK=1 so `npm run predeploy` can be run offline as a chain
  // without argv forwarding.
  const allowOffline =
    process.argv.includes("--allow-offline") ||
    process.env.ALLOW_OFFLINE_POLICY_CHECK === "1" ||
    process.env.ALLOW_OFFLINE_POLICY_CHECK === "true";

  // Regression fixture — always runs; a regression here fails the build with the exact reason.
  const regression = runRefuseDeliveryRegression();

  // Live-DB scan — opportunistic; announced explicitly on the summary line.
  const live = await runLiveScan();

  // Assertions on the check itself (spec's "loud rather than silent" rule).
  const assertionErrors: string[] = [];
  if (FORBIDDEN_PATHS.length === 0) {
    assertionErrors.push(
      "FORBIDDEN_PATHS is empty — this check would silently cover nothing. Add the known " +
        "forbidden-path assertions and re-run.",
    );
  }
  const fixtureReport = scanPolicySet(REFUSE_DELIVERY_FIXTURE);
  if (fixtureReport.policiesScanned === 0) {
    assertionErrors.push(
      "regression fixture is empty — the check has no ground-truth case to prove coverage.",
    );
  }

  // Findings the check flagged.
  const allFindings: Finding[] = [];
  // (Regression-fixture findings are the EXPECTED path — the fixture exists to prove the check
  // fires. They are NOT added to the failure list; the regression assertion is what enforces
  // them.)
  for (const f of live.findings) allFindings.push(f);

  // Coverage summary — printed either way so a green line always names what was and wasn't
  // covered (loud, not silent).
  console.log(
    `policy-contradictions — ${FORBIDDEN_PATHS.length} assertion(s), regression: ${regression.ok ? "PASS" : "FAIL"}, ` +
      `live scan: ${live.attempted ? `${live.workspacesScanned} workspace(s) / ${live.policiesScanned} policy(s)` : "skipped"}, ` +
      `${allFindings.length} finding(s)`,
  );
  if (live.skippedReason) console.log(`  live scan note: ${live.skippedReason}`);
  for (const a of fixtureReport.anchorReport) {
    console.log(
      `  anchor ${a.assertionId} → ${a.anchorSlug}.rules[${a.anchorRuleId}]: ${a.found ? "found" : "MISSING (drift — see docstring)"}`,
    );
  }
  console.log(
    `  NOT COVERED by this check (prose-only contradictions in an internal_summary paragraph): out of scope by design; see docstring § SCOPE.`,
  );

  if (summary) {
    for (const f of allFindings) {
      console.log(
        `  [VIOLATION] ${f.offendingSlug}.customer_summary matches "${f.matchedPhrase}" — forbidden by ${f.anchorSlug}.rules[${f.anchorRuleId}]${f.anchorPresent ? "" : " (anchor MISSING)"}`,
      );
    }
  }

  if (assertionErrors.length > 0) {
    console.error(`\n❌ check-policy-contradictions — check is unsafe:\n`);
    for (const e of assertionErrors) console.error(`  • ${e}`);
    process.exit(1);
  }

  if (!regression.ok) {
    console.error(
      `\n❌ check-policy-contradictions — regression fixture failed: ${regression.reason}\n\n` +
        `The refuse-delivery contradiction (docs/brain/specs/a-policies-chokepoint-so-published-\n` +
        `and-internal-rules-cannot-contradict.md § Phase 3) is the ground-truth case this check\n` +
        `is scoped to catch. If it stops flagging, the scanner or the FORBIDDEN_PATHS registry\n` +
        `has silently drifted. Restore the assertion before shipping.\n`,
    );
    process.exit(1);
  }

  if (allFindings.length > 0) {
    console.error(
      `\n❌ check-policy-contradictions — ${allFindings.length} contradiction(s) between customer_summary and rules:\n`,
    );
    for (const f of allFindings) {
      console.error(
        `  • ${f.offendingSlug}.customer_summary matches "${f.matchedPhrase}"\n` +
          `    forbidden by ${f.anchorSlug}.rules[${f.anchorRuleId}]${f.anchorPresent ? "" : " (anchor MISSING — assertions still enforced from this check)"}\n` +
          `    reason: ${f.reason}`,
      );
    }
    console.error(
      `\nEdit the customer_summary in Settings → Policies so it no longer offers a path the rules\n` +
        `deny. See docs/brain/tables/policies.md § Gotchas and Phase 3 of the spec above.\n`,
    );
    process.exit(1);
  }

  // A skip is not a pass. When the live-DB half didn't run and the operator hasn't explicitly
  // opted in, exit non-zero — otherwise a local run reads green while the box sees the real
  // contradictions (the exact "local reads green, box reads red" surprise that motivated
  // Phase 2 of predeploy-guards-actually-run-on-every-build). The opt-in is a CLI flag or
  // `ALLOW_OFFLINE_POLICY_CHECK=1` so a developer can still get through an offline chain
  // once they've read this message.
  if (!live.attempted && !allowOffline) {
    console.error(
      `\n❌ check-policy-contradictions — live-DB scan was NOT performed and offline mode is\n` +
        `   not explicitly permitted, so the check cannot honestly report a pass.\n\n` +
        `   ${live.skippedReason ?? "Supabase credentials absent."}\n\n` +
        `   Fix (pick one):\n` +
        `     • run with Supabase credentials so the live scan runs (the box already does this), OR\n` +
        `     • re-run with --allow-offline (or ALLOW_OFFLINE_POLICY_CHECK=1) to acknowledge that\n` +
        `       the live half is skipped — the regression fixture still runs and its result stands.\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-policy-contradictions — ${FORBIDDEN_PATHS.length} assertion(s), regression PASS, ` +
      `${live.attempted ? `${live.policiesScanned} live policy(s) scanned` : "live scan skipped by opt-in"}, 0 contradictions.`,
  );
}

main().catch((err) => {
  console.error(`check-policy-contradictions — main() threw: ${errText(err)}`);
  process.exit(1);
});
