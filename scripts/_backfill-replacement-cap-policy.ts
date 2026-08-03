/**
 * One-time backfill: record the CEO ceiling of 2026-08-02 on the Exchange &
 * Replacement policy's INTERNAL half (the half both Sol and June actually
 * consume) — never replace more than 4 units of a single VARIANT.
 *
 * Why: On 2026-08-02 a customer was told, in writing, that the cap exists —
 * so it should be true in code rather than a convention someone remembers.
 * Measured across the same day: exactly one replacement in 87 has ever
 * exceeded the ceiling (6 units, 2026-08-01), so this is cheap insurance
 * rather than a live fire. The cap is PER VARIANT — a legitimate
 * multi-flavour 4 + 4 is fine, 8 of one flavour is not. That is the
 * distinction the CEO drew.
 *
 * WHY THE EXCHANGES POLICY: the `exchanges` policy is the AI-facing rulebook
 * for free replacement orders — it already carries `exchanges.valid_triggers`,
 * `exchanges.return_required_by_trigger` and the existing 2-unit escalation
 * threshold. Both Sol (via `getAgentPolicyPackage` in
 * [[../src/lib/policies]]) and June (via the CS-director brief loader) read
 * the same package, so the machine rule surfaces wherever a replacement
 * decision is made.
 *
 * The rule is INDEPENDENT of the existing `exchanges.unit_escalation_threshold=2`
 * (which flags replacements over 2 units for agent review): the 4-per-variant
 * ceiling is a HARD refuse point that the SDK enforces (Phase 2) and escalates
 * (Phase 3). Both live on the same policy so the two thresholds are visible in
 * one place.
 *
 * Do NOT touch `customer_summary` — the published half is derived, and editing
 * it to match is exactly how the two halves drift apart (the 2026-08-02
 * refuse-delivery incident's failure mode; see [[../docs/brain/tables/policies]]).
 *
 * Idempotent — re-running finds the ruling text already present and the rule
 * id already in `rules[]` and exits clean (no version bump). Auto-ledgered by
 * the post-merge ship-time-backfill detector because of the
 * `scripts/_backfill-*.ts` filename convention, and drained on the box by
 * `executeShipTimeBackfillsForSpec`.
 *
 * Dry-run by default. Pass `--apply` to write; `APPLY=1` also works.
 *
 *   npx tsx scripts/_backfill-replacement-cap-policy.ts            # dry-run
 *   npx tsx scripts/_backfill-replacement-cap-policy.ts --apply    # write
 *
 * Spec: docs/brain/specs/replacement-orders-label-honestly-and-cap-at-four-units.md Phase 1.
 */
import { createAdminClient } from "./_bootstrap";
import { getPolicy, updatePolicyText } from "../src/lib/policies";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";
const EXCHANGES_SLUG = "exchanges";
const NEW_RULE_ID = "exchanges.replacement_max_units_per_variant";

/**
 * Anchor line the ceiling attaches to. Chosen because the existing "Limits &
 * Escalation" block is where the 2-unit escalation threshold already lives —
 * the two limits belong together. If a future hand-edit removed this line the
 * backfill throws rather than silently corrupting the live policy text.
 */
const ANCHOR_LINE = "## Limits & Escalation";

/**
 * Additional prose describing the CEO ceiling. Injected immediately after the
 * anchor so it sits at the top of the "Limits & Escalation" block, with the
 * 2-unit soft escalation right below it — the two thresholds are visible in
 * one place and the reader sees the hard cap first.
 */
const NEW_LINES = [
  "## Limits & Escalation",
  "- CEO ceiling 2026-08-02: NEVER replace more than 4 units of a SINGLE variant on one order. Cap is PER VARIANT, not per order — a 4 + 4 multi-flavour replacement is in-policy; 8 of one flavour is not. Measured grounding: 1 replacement in 87 has ever exceeded it (6 units, 2026-08-01). A customer was told on 2026-08-02 that this cap exists, so it is true in code. Machine rule: exchanges.replacement_max_units_per_variant (see RULES). Over-cap requests do NOT silently truncate to 4 — the SDK refuses and the caller escalates for a decision.",
].join("\n");

/**
 * Machine-readable assertion for the ceiling. Renders in the shared agent
 * policy package via `formatRule` in `src/lib/policies.ts` as
 * `- <assertion>: <detail>`, so Sol and June state the cap consistently.
 */
const NEW_RULE = {
  id: NEW_RULE_ID,
  assertion: "Never replace more than 4 units of a single variant on one order",
  detail:
    "Cap is PER VARIANT, not per order — 4 + 4 across two flavours is fine, 8 of one is not. Enforced in `src/lib/replacement-order.ts` `createReplacementOrder` (constant `REPLACEMENT_MAX_UNITS_PER_VARIANT`). Do NOT silently truncate — refuse and escalate. An over-cap request raises a CEO approval card via `dashboard_notifications` (type='agent_approval_request', metadata.routed_to_function='ceo') carrying the ticket, customer, variant and requested quantity.",
  ruling_date: "2026-08-02",
  ruling_by: "ceo",
  value: 4,
  scope: "per_variant",
} as const;

type WorkspaceRow = { id: string; name: string | null };

async function runOne(workspaceId: string): Promise<{
  noop: boolean;
  reason: string;
  version?: number;
}> {
  const admin = createAdminClient();
  const pol = await getPolicy(admin, workspaceId, EXCHANGES_SLUG);
  if (!pol) return { noop: true, reason: `no active ${EXCHANGES_SLUG} policy` };

  const rulesArr = Array.isArray(pol.rules) ? pol.rules : [];
  const alreadyHasRule = rulesArr.some(
    r => r && typeof r === "object" && (r as { id?: string }).id === NEW_RULE_ID,
  );
  const alreadyHasProse = pol.internal_summary.includes(NEW_RULE_ID);

  if (alreadyHasRule && alreadyHasProse) {
    return { noop: true, reason: "prose + rule already present", version: pol.version };
  }

  let nextInternal = pol.internal_summary;
  if (!alreadyHasProse) {
    if (!pol.internal_summary.includes(ANCHOR_LINE)) {
      throw new Error(
        `anchor line missing from ${EXCHANGES_SLUG}.internal_summary — refusing to write. ` +
          `The seeded "Limits & Escalation" block has drifted; reconcile by hand before re-running. ` +
          `Anchor: ${ANCHOR_LINE}`,
      );
    }
    nextInternal = pol.internal_summary.replace(ANCHOR_LINE, NEW_LINES);
  }
  const nextRules = alreadyHasRule ? rulesArr : [...rulesArr, NEW_RULE];

  if (!APPLY) {
    const parts: string[] = [];
    if (!alreadyHasProse) parts.push("would insert ceiling prose");
    if (!alreadyHasRule) parts.push(`would append ${NEW_RULE_ID} to rules[]`);
    return { noop: false, reason: parts.join(" + "), version: pol.version };
  }

  const res = await updatePolicyText(admin, workspaceId, EXCHANGES_SLUG, {
    internal_summary: nextInternal,
    rules: nextRules,
    updated_by: null,
  });
  return {
    noop: !res.versionBumped,
    reason: res.versionBumped ? `bumped to v${res.version}` : `unchanged (v${res.version})`,
    version: res.version,
  };
}

(async () => {
  const admin = createAdminClient();
  console.log(`replacement_cap_policy_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  target: ${EXCHANGES_SLUG}.internal_summary + rules[${NEW_RULE_ID}]`);
  console.log(
    `  scope:  every workspace's active ${EXCHANGES_SLUG} policy (idempotent per workspace)\n`,
  );

  const { data: workspaces, error } = await admin
    .from("workspaces")
    .select("id, name")
    .order("id", { ascending: true });
  if (error) throw new Error(`workspaces read failed: ${error.message}`);
  const rows = (workspaces ?? []) as WorkspaceRow[];

  let scanned = 0;
  let noop = 0;
  let written = 0;
  let would = 0;
  let errored = 0;

  for (const w of rows) {
    scanned++;
    const label = `${w.name ?? "(unnamed)"} (${w.id})`;
    try {
      const res = await runOne(w.id);
      if (res.noop) {
        noop++;
        console.log(`  no-op    ${label} — ${res.reason}`);
      } else if (APPLY) {
        written++;
        console.log(`  written  ${label} — ${res.reason}`);
      } else {
        would++;
        console.log(`  would    ${label} — ${res.reason}`);
      }
    } catch (e) {
      errored++;
      console.error(`  ERROR    ${label} — ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log("");
  if (APPLY) {
    console.log(
      `result: scanned=${scanned} no-op=${noop} written=${written} errored=${errored}`,
    );
  } else {
    console.log(
      `result: scanned=${scanned} no-op=${noop} would-write=${would} errored=${errored} ` +
        `(dry-run — re-run with --apply to write)`,
    );
  }
  if (errored > 0) process.exit(1);
})().catch(e => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
