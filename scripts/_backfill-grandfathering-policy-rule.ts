/**
 * One-time backfill: record the CEO ruling of 2026-08-01 on the Subscription
 * policy's INTERNAL half (the half both Sol and June actually consume) — the
 * 50% MSRP floor governs an INFERRED baseline, not a rate the customer
 * demonstrably paid. Where renewal history shows a sustained lower rate, that
 * rate is the customer's rate and restoring to it is correct even though it
 * falls below the floor.
 *
 * Why: on 2026-07-31 Vicki (cvent@gci.net, 15 orders) wrote in because the
 * $24.95 per box she had paid since 2025 had jumped to $59.96. Sol diagnosed
 * it exactly right and escalated to June. June diagnosed it exactly right —
 * quoting her actual renewal history — and escalated to the founder. Neither
 * agent could act: both concluded the $24.95 rate "can no longer be offered"
 * because they were reasoning from the floor rule as an absolute. On
 * 2026-08-01 the CEO overruled that reading (57 subscriptions were restored
 * below the floor that day, each with 12–29 renewals at exactly that rate;
 * Vicki's own history is four consecutive renewals at $24.95), but the
 * ruling was never written into the AI-facing rulebook. So a leash change
 * alone would not have helped — with the lever in hand both agents would
 * still have refused. This backfill closes that gap: the definitional floor
 * statement in the `subscriptions` policy's `internal_summary` gains the
 * ruling text, and a machine-readable rule `pricing.historical_rate_beats_floor`
 * joins `rules[]` so an agent cannot weight it differently each turn.
 *
 * WHY THE SUBSCRIPTIONS POLICY (not `refunds`): the `subscriptions` policy
 * carries the DEFINITIONAL floor statement ("50% MSRP floor: absolute minimum
 * realized price" — the exact wording the CEO overruled). The `refunds`
 * policy references the floor operationally but the definitional home is
 * `subscriptions`, and both agents read the shared agent policy package
 * (src/lib/policies.ts `getAgentPolicyPackage`) which includes every active
 * policy's `internal_summary` + `rules[]`, so the machine rule surfaces
 * regardless of which decision path they enter.
 *
 * Do NOT touch `customer_summary` — the published half is derived, and
 * editing it to match is exactly how the two halves drift apart (the
 * 2026-08-02 refuse-delivery incident's failure mode).
 *
 * Idempotent — re-running finds the ruling text already present and the
 * rule id already in `rules[]` and exits clean (no version bump). Auto-
 * ledgered by the post-merge [[../src/lib/ship-time-backfill-detector]]
 * because of the `scripts/_backfill-*.ts` filename convention, and drained
 * on the box by `executeShipTimeBackfillsForSpec` in
 * [[../src/lib/ship-time-backfill-executor]].
 *
 * Dry-run by default. Pass `--apply` to write; `APPLY=1` also works.
 *
 *   npx tsx scripts/_backfill-grandfathering-policy-rule.ts            # dry-run
 *   npx tsx scripts/_backfill-grandfathering-policy-rule.ts --apply    # write
 *
 * Spec: docs/brain/specs/june-restores-a-grandfathered-price-without-escalating.md Phase 1.
 */
import { createAdminClient } from "./_bootstrap";
import { getPolicy, updatePolicyText } from "../src/lib/policies";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";
const SUBS_SLUG = "subscriptions";
const NEW_RULE_ID = "pricing.historical_rate_beats_floor";

/**
 * Anchor line the ruling replaces. Chosen because it contains the exact
 * misconception ("absolute minimum realized price") the CEO overruled. If a
 * future hand-edit removed this line the backfill throws rather than silently
 * corrupting the live policy text — a human then reconciles by hand.
 */
const OLD_LINE =
  "- 50% MSRP floor: absolute minimum realized price. Below-floor historicals were raised to floor (one-time cleanup).";

/**
 * Replacement prose. Reworded floor statement + CEO ruling + explicit
 * back-reference to the machine rule so an agent reading the prose knows a
 * checkable assertion covers the same ground.
 */
const NEW_LINES = [
  "- 50% MSRP floor: the minimum for an INFERRED baseline (a rate we compute when we lack direct evidence of what the customer paid). Below-floor historicals were raised to floor in a one-time cleanup; that raise did not extinguish demonstrated rates.",
  "- CEO ruling 2026-08-01: a customer's DEMONSTRATED historical rate — a rate their own renewal history shows they were charged over a sustained window — is honoured over the 50%-MSRP floor. Restoring to a demonstrated rate is correct even when it falls below the floor. Grounding: 57 subscriptions were restored below the floor on 2026-08-01, each with 12–29 renewals at exactly that rate; Vicki's own history is four consecutive renewals at $24.95. Machine rule: pricing.historical_rate_beats_floor (see RULES).",
].join("\n");

/**
 * Machine-readable assertion the CEO ruling encodes. The renderer in
 * `src/lib/policies.ts` `formatRule` prints `{ assertion, detail }` entries
 * as `- <assertion>: <detail>`, so this surfaces in the shared agent policy
 * package Sol and June both embed in their prompts.
 */
const NEW_RULE = {
  id: NEW_RULE_ID,
  assertion:
    "A customer's demonstrated historical rate beats the 50%-MSRP floor",
  detail:
    "When renewal history for the same variant shows a sustained rate materially below the current line price AND that established rate falls below the 50% MSRP floor, restoring the line to the demonstrated rate is in-policy. The value must be computed via subscription-overcharge.deriveRestoreBase (never a number an agent supplied), and a raise attempt classified by isRaiseAttempt still refuses.",
  ruling_date: "2026-08-01",
  ruling_by: "ceo",
  supersedes: "the 'floor is absolute' reading of subs.floor_pct",
} as const;

type WorkspaceRow = { id: string; name: string | null };

async function runOne(workspaceId: string): Promise<{
  noop: boolean;
  reason: string;
  version?: number;
}> {
  const admin = createAdminClient();
  const pol = await getPolicy(admin, workspaceId, SUBS_SLUG);
  if (!pol) return { noop: true, reason: `no active ${SUBS_SLUG} policy` };

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
    if (!pol.internal_summary.includes(OLD_LINE)) {
      throw new Error(
        `anchor line missing from ${SUBS_SLUG}.internal_summary — refusing to write. ` +
          `The seeded floor statement has drifted; reconcile by hand before re-running. ` +
          `Anchor: ${OLD_LINE}`,
      );
    }
    nextInternal = pol.internal_summary.replace(OLD_LINE, NEW_LINES);
  }
  const nextRules = alreadyHasRule ? rulesArr : [...rulesArr, NEW_RULE];

  if (!APPLY) {
    const parts: string[] = [];
    if (!alreadyHasProse) parts.push("would rewrite floor line");
    if (!alreadyHasRule) parts.push(`would append ${NEW_RULE_ID} to rules[]`);
    return { noop: false, reason: parts.join(" + "), version: pol.version };
  }

  const res = await updatePolicyText(admin, workspaceId, SUBS_SLUG, {
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
  console.log(`grandfathering_policy_rule_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  target: ${SUBS_SLUG}.internal_summary + rules[${NEW_RULE_ID}]`);
  console.log(
    `  scope:  every workspace's active ${SUBS_SLUG} policy (idempotent per workspace)\n`,
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
