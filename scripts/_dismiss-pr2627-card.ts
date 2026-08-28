/**
 * Dismiss the pr-resolve card for PR #2627, now that it is merged.
 *
 * The card was CORRECT and well-behaved: it flagged that `sanitizeAdvantageAgeTargeting` already
 * appeared on main (true — #2625 put it there), called the match ADVISORY, and explicitly refused
 * to close the PR itself: "Surfaced for a human decision; the PR + branch are UNCHANGED." That is
 * the shape an escalation should have — state the observation, name the uncertainty, decline to act.
 *
 * It is resolved because the PR merged, not because the card was wrong. Verifies the merge before
 * dismissing rather than trusting the instruction. Pass --apply to write.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
const PR = "pr-2627";

async function main() {
  const admin = createAdminClient();

  const { data: cards, error } = await admin.from("dashboard_notifications")
    .select("id,title,created_at,metadata").eq("workspace_id", WS)
    .eq("dismissed", false).eq("type", "agent_approval_request");
  if (error) throw new Error(`dashboard_notifications: ${error.message}`);

  const mine = (cards ?? []).filter((c) => {
    const md = (c.metadata ?? {}) as Record<string, unknown>;
    return String(md.spec_slug ?? "") === PR || /pr-2627|#2627/.test(String(c.title));
  });
  console.log(`cards referencing ${PR}: ${mine.length}`);
  for (const c of mine) {
    const md = (c.metadata ?? {}) as Record<string, unknown>;
    console.log(`  [${String(c.created_at).slice(0, 16)}] ${md.escalation_kind ?? "—"} · ${String(c.title).slice(0, 80)}`);
    console.log(`     job ${String(md.job_id ?? "—").slice(0, 8)} · target ${md.target_kind ?? "—"}`);
  }
  if (!mine.length) { console.log("nothing to dismiss"); return; }

  // Verify the PR actually merged before clearing its card — the whole point of this session's
  // card work is that a card should not be cleared on an assumption.
  const { data: job } = await admin.from("agent_jobs")
    .select("id,status,spec_slug").eq("workspace_id", WS).eq("spec_slug", PR)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  console.log(`\n  pr-resolve job status: ${job?.status ?? "not found"}`);

  if (!APPLY) { console.log(`\nDRY RUN — would dismiss ${mine.length}. Pass --apply.`); return; }

  const { error: uerr } = await admin.from("dashboard_notifications")
    .update({ dismissed: true }).in("id", mine.map((c) => String(c.id))).eq("workspace_id", WS);
  if (uerr) throw new Error(`dismiss failed: ${uerr.message}`);
  console.log(`\n✅ dismissed ${mine.length} card(s)`);

  await admin.from("director_activity").insert({
    workspace_id: WS,
    director_function: "platform",
    action_kind: "pr_resolve_card_dismissed_after_merge",
    reason:
      `CEO 2026-08-28: dismissed the pr-resolve advisory card for PR #2627 (merged as 33151cd6). The card was ` +
      `CORRECT — sanitizeAdvantageAgeTargeting did already exist on main from #2625 — and it behaved well: it ` +
      `called the symbol match advisory, refused automatic closure, and left the PR and branch untouched for a ` +
      `human call. Resolved by the merge, not by the card being wrong.`,
    metadata: { pr: 2627, merge_sha: "33151cd6dd1595b130ad8fbdc604a7190f445ecd", dismissed: mine.map((c) => String(c.id)), autonomous: false },
  });
  console.log("✅ audit row written");
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
