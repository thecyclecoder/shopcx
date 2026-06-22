/**
 * Amend the active `exchanges` policy so an allergy/medical-reaction report
 * ESCALATES to a human for safety review instead of authorizing a same-turn,
 * no-clarification cash refund.
 *
 * Spec: docs/brain/specs/allergy-safety-escalate-not-auto-refund.md
 * Derived-from-ticket: 46471a76-3c9b-4f11-b171-4ca2ff6934d9 (Myra Eppright —
 * "deathly ill"; orchestrator fired a direct partial_refund of $64.91 to the
 * card on her UNWANTED, never-shipped June 20 renewal with no return, no
 * refund-playbook routing, and no escalation).
 *
 * New behavior aligns the live policy text with sonnet_prompt #e0147885
 * ("tickets are anomalies") and playbooks/refund.md ("no cash refund to card
 * without a return"):
 *   (a) genuine allergy/medical reaction on a RECEIVED order -> acknowledge +
 *       action_type='escalate'; never auto-issue a cash refund;
 *   (b) replacement-chosen path keeps prepaid-return + refund_amount=0 as today;
 *   (c) any cash refund routes through the Refund playbook (return on fulfilled,
 *       void/cancel on unfulfilled — never refund-to-card);
 *   (d) closes the return-required-matrix gap (refund-chosen allergy path).
 *
 * Idempotent: re-running detects the new text + rule and skips. Surgical —
 * touches ONLY the exchanges row in place (does NOT re-seed the other policies,
 * which have drifted from scripts/seed-policies-v1.ts).
 */
// `_bootstrap` loads `.env.local` when present (local dev) and is a no-op on
// the build box (secrets come from the systemd EnvironmentFile) — never read
// `.env.local` directly, it's ABSENT on the box.
import { createAdminClient } from "./_bootstrap";
const admin = createAdminClient();

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// ── Anchored replacements against the live internal_summary ──────────────────
const REPLACEMENTS: { old: string; new: string }[] = [
  {
    old: "5. Allergy/safety override — customer reports allergy/medical reaction; replacement OR refund, same turn, no clarification",
    new: "5. Allergy/safety override — customer reports an allergy/medical reaction. SAFETY-CRITICAL anomaly: acknowledge the concern every turn and ESCALATE for human safety review (action_type='escalate'). Do NOT pre-commit a same-turn cash refund or pick the resolution for them. A replacement may be offered if the customer explicitly wants one (see matrix); any cash refund routes through the Refund playbook (return required on a fulfilled order; void/cancel an unfulfilled order — never refund-to-card without a return).",
  },
  {
    old: "- Allergy/safety (replacement chosen) → YES, prepaid label, refund_amount=0",
    new: "- Allergy/safety (replacement chosen) → YES, prepaid label, refund_amount=0\n- Allergy/safety (refund/cash chosen) → ESCALATE for human safety review first. NO refund-to-card without a return: route any approved cash refund through the Refund playbook — return required on a fulfilled order; void/cancel an UNFULFILLED (never-shipped) order instead of refunding-to-card.",
  },
  {
    old: `## Allergy Override Priority
- Allergy/medical reaction in the customer's message: HIGHEST PRIORITY. Replacement OR refund same turn. NEVER close as resolved without acknowledging the safety concern. If unable to execute the action, escalate with "allergy/safety report — needs immediate review."`,
    new: `## Allergy Override Priority
- Allergy/medical reaction in the customer's message: HIGHEST PRIORITY for acknowledgment + safety — but a genuine reaction is a safety-critical anomaly, NOT a self-serve refund trigger (tickets are anomalies: do NOT pre-commit a refund or replacement). Required behavior: (1) acknowledge the safety concern warmly, every turn; (2) action_type='escalate' for human safety review, escalation_reason "allergy/safety report — needs immediate review"; (3) NEVER auto-issue a same-turn cash refund to the card, and NEVER close as resolved without human review. A replacement may be offered only if the customer explicitly wants one (prepaid return + refund_amount=0, see matrix). Any cash refund — including an unwanted-renewal dispute riding on the same ticket — goes through the Refund playbook, which requires a return on a fulfilled order and voids/cancels an UNFULFILLED (never-shipped) order rather than refunding-to-card.`,
  },
];

// Sentinel proving the new text is already present (idempotency check).
const SENTINEL = "SAFETY-CRITICAL anomaly: acknowledge the concern every turn and ESCALATE";

type Rule = { id: string; [k: string]: unknown };

function patchRules(rules: Rule[]): Rule[] {
  const out = rules.map((r) =>
    r.id === "exchanges.allergy_override_priority"
      ? {
          ...r,
          value: "highest",
          action: "escalate",
          note: "Acknowledge safety + escalate for human review; never auto cash refund; replacement optional same turn; cash refund only via Refund playbook (return on fulfilled, void/cancel on unfulfilled)",
        }
      : r,
  );
  if (!out.some((r) => r.id === "exchanges.allergy_refund_requires_return")) {
    // Insert right before the playbook_id rule if present, else append.
    const newRule: Rule = {
      id: "exchanges.allergy_refund_requires_return",
      value: true,
      note: "No refund-to-card on an allergy report without a return. Fulfilled → return via Refund playbook; unfulfilled → void/cancel; genuine reaction → escalate for human safety review.",
    };
    const idx = out.findIndex((r) => r.id === "exchanges.playbook_id");
    if (idx >= 0) out.splice(idx, 0, newRule);
    else out.push(newRule);
  }
  return out;
}

async function main() {
  const { data: pol } = await admin
    .from("policies")
    .select("id, internal_summary, rules, version")
    .eq("workspace_id", WS)
    .eq("slug", "exchanges")
    .eq("is_active", true)
    .is("superseded_by", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!pol) throw new Error("active exchanges policy not found");

  let summary = pol.internal_summary as string;
  const alreadyText = summary.includes(SENTINEL);

  if (alreadyText) {
    console.log("- internal_summary already amended, skipping text");
  } else {
    for (const { old, new: next } of REPLACEMENTS) {
      if (!summary.includes(old)) {
        throw new Error(
          `anchor not found in live internal_summary (policy drifted?):\n${old.slice(0, 80)}…`,
        );
      }
      summary = summary.replace(old, next);
    }
  }

  const rules = patchRules((pol.rules as Rule[]) || []);
  const rulesChanged = JSON.stringify(rules) !== JSON.stringify(pol.rules);

  if (alreadyText && !rulesChanged) {
    console.log("✓ exchanges policy already up to date — nothing to do");
    return;
  }

  const { error } = await admin
    .from("policies")
    .update({ internal_summary: summary, rules, updated_at: new Date().toISOString() })
    .eq("id", pol.id);
  if (error) throw error;
  console.log(`✓ exchanges policy amended (v${pol.version}, in place) — allergy/safety now escalates`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
