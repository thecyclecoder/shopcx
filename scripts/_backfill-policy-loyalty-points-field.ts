/**
 * One-time backfill: replace the legacy `customer.loyalty_points` field in the
 * live `refunds` policy with the supported `loyalty.points_balance` field
 * (backed by `public.loyalty_members.points_balance`).
 *
 * Why: the Control Tower logged a Postgres 500 on a policy consumer that tried
 * to read the field as a column on `public.customers` — loyalty balance is a
 * separate loyalty-member concept, not a customer column. The SDK chokepoint
 * in `src/lib/policies.ts` (`normalizePolicyRuleFieldRefs`, called from
 * `getAgentPolicyPackage`) now rewrites the field on read so downstream agents
 * see the supported name; this script durably repairs the stored row so a
 * consumer that reads the table by another path also gets the correct field.
 * Anchored + idempotent — re-running finds the supported field already in
 * place and exits clean without a version bump.
 *
 * WHY THE REFUNDS POLICY: the Tier 0 "loyalty save" rule that references
 * loyalty balance lives in `refunds.internal_summary` + `refunds.rules[]`
 * (`refunds.tier_0_loyalty_save`). Only that policy is patched; other
 * policies do not carry the legacy field.
 *
 * Do NOT touch `customer_summary` — the published half never carried the
 * technical field name, and editing it to match is exactly how the two halves
 * drift apart (the 2026-08-02 refuse-delivery incident's failure mode).
 *
 * Auto-ledgered by the post-merge [[../src/lib/ship-time-backfill-detector]]
 * because of the `scripts/_backfill-*.ts` filename convention, and drained on
 * the box by `executeShipTimeBackfillsForSpec` in
 * [[../src/lib/ship-time-backfill-executor]].
 *
 * Dry-run by default. Pass `--apply` to write; `APPLY=1` also works.
 *
 *   npx tsx scripts/_backfill-policy-loyalty-points-field.ts            # dry-run
 *   npx tsx scripts/_backfill-policy-loyalty-points-field.ts --apply    # write
 *
 * Spec: docs/brain/specs/policy-loyalty-points-field-normalization.md Phase 1.
 */
import { createAdminClient } from "./_bootstrap";
import { getPolicy, updatePolicyText } from "../src/lib/policies";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";
const REFUNDS_SLUG = "refunds";
const LEGACY_FIELD = "customer.loyalty_points";
const SUPPORTED_FIELD = "loyalty.points_balance";
const TIER_0_RULE_ID = "refunds.tier_0_loyalty_save";

type WorkspaceRow = { id: string; name: string | null };

function rewriteRulesArray(rules: unknown[]): { next: unknown[]; changed: boolean } {
  let changed = false;
  const next = rules.map(rule => {
    if (typeof rule === "string") {
      if (rule.includes(LEGACY_FIELD)) {
        changed = true;
        return rule.split(LEGACY_FIELD).join(SUPPORTED_FIELD);
      }
      return rule;
    }
    if (rule && typeof rule === "object") {
      const src = rule as Record<string, unknown>;
      const out: Record<string, unknown> = { ...src };
      let touched = false;
      for (const [k, v] of Object.entries(src)) {
        if (typeof v === "string" && v.includes(LEGACY_FIELD)) {
          out[k] = v.split(LEGACY_FIELD).join(SUPPORTED_FIELD);
          touched = true;
        }
      }
      if (touched) changed = true;
      return touched ? out : rule;
    }
    return rule;
  });
  return { next, changed };
}

async function runOne(workspaceId: string): Promise<{
  noop: boolean;
  reason: string;
  version?: number;
}> {
  const admin = createAdminClient();
  const pol = await getPolicy(admin, workspaceId, REFUNDS_SLUG);
  if (!pol) return { noop: true, reason: `no active ${REFUNDS_SLUG} policy` };

  const proseHasLegacy = pol.internal_summary.includes(LEGACY_FIELD);
  const rulesArr = Array.isArray(pol.rules) ? pol.rules : [];
  const { next: nextRules, changed: rulesChanged } = rewriteRulesArray(rulesArr);

  if (!proseHasLegacy && !rulesChanged) {
    return {
      noop: true,
      reason: `already normalized (${SUPPORTED_FIELD})`,
      version: pol.version,
    };
  }

  const nextInternal = proseHasLegacy
    ? pol.internal_summary.split(LEGACY_FIELD).join(SUPPORTED_FIELD)
    : pol.internal_summary;

  if (!APPLY) {
    const parts: string[] = [];
    if (proseHasLegacy) parts.push("would rewrite internal_summary");
    if (rulesChanged) parts.push(`would rewrite rules[${TIER_0_RULE_ID}]`);
    return { noop: false, reason: parts.join(" + "), version: pol.version };
  }

  const patch: {
    internal_summary?: string;
    rules?: unknown[];
    updated_by: null;
  } = { updated_by: null };
  if (proseHasLegacy) patch.internal_summary = nextInternal;
  if (rulesChanged) patch.rules = nextRules;

  const res = await updatePolicyText(admin, workspaceId, REFUNDS_SLUG, patch);
  return {
    noop: !res.versionBumped,
    reason: res.versionBumped ? `bumped to v${res.version}` : `unchanged (v${res.version})`,
    version: res.version,
  };
}

(async () => {
  const admin = createAdminClient();
  console.log(`policy_loyalty_points_field_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  target: ${REFUNDS_SLUG}.internal_summary + rules[${TIER_0_RULE_ID}]`);
  console.log(
    `  scope:  every workspace's active ${REFUNDS_SLUG} policy (idempotent per workspace)\n`,
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
