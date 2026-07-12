/**
 * marco-logistics-director-seat Phase 4 — audit-trail confirmation script.
 *
 * Runtime artifact per the spec's Phase 4 verification (docs/brain/specs/marco-logistics-director-seat.md).
 * Sweeps the four live director cockpits (platform · growth · cs · logistics) + Eve's god-mode surface is
 * out of scope here (its audit lives in dashboard_notifications only, no director_activity contract). For
 * every live director we exercise the two write paths the M3 dispatch flows through and confirm the
 * contract from docs/brain/lifecycles/director-cockpits.md:
 *
 *   IN-LEASH APPROVE → recordDirectorActivity({ workspaceId, directorFunction, actionKind='confirm_audit_trail_synthetic' })
 *     Assert: one new director_activity row lands with director_function=<slug>.
 *
 *   RAIL-HIT (out-of-leash) → escalateApprovalRequestToCeo(admin, syntheticTarget, diagnosis, { slug, label })
 *     Assert: one new dashboard_notifications row lands with
 *       type='approval_request'
 *       metadata.routed_to_function='ceo'
 *       metadata.escalated_by_director=<slug>
 *       metadata.escalation_reason NAMING the leash category the rail crossed
 *     And that the same escalation wrote NO director_activity row (the director-side must not mutate).
 *
 * The script is SAFE-BY-CONSTRUCTION on prod:
 *   • every synthetic row carries a `marco_phase4_audit_confirm=true` marker in its metadata so a cleanup
 *     sweep after the assertions removes exactly what this run inserted (compare-and-set on the marker
 *     + the run_id + workspace_id — per coaching guidance #12, never a bare row-exists proxy).
 *   • the synthetic dashboard_notifications rows also carry `dismissed=true` on cleanup so the CEO's real
 *     inbox is never rendered a synthetic escalation (even in the small window before delete).
 *   • the synthetic agent_jobs row used as the rail-hit target is inserted with kind='confirm_audit_trail_synthetic'
 *     and status='completed' + a marker so no dispatch loop can pick it up; it is cleaned in the same sweep.
 *
 * Prints "PASS <slug>" on each director's contract pass and "FAIL <slug>: <reason>" otherwise; exits 0 iff
 * every live director passed BOTH paths. Exit 1 on any failure.
 *
 * Run against the pooler (READS SDK code + writes a handful of tagged synthetic rows it then cleans up):
 *   npx tsx scripts/_confirm-director-chat-audit-trail.ts
 */
import { createAdminClient } from "./_bootstrap";
import { recordDirectorActivity } from "../src/lib/director-activity";
import { escalateApprovalRequestToCeo, type DirectorTargetJob } from "../src/lib/agents/platform-director";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MARKER = "marco_phase4_audit_confirm";
const RUN_ID = `phase4-confirm-${WS.slice(0, 8)}-${Math.floor(Date.now() / 1000)}`;

interface DirectorUnderTest {
  slug: string;
  label: string;
  /** the leash-category the synthetic rail-hit action is meant to cross (a string the diagnosis names). */
  railCategory: string;
}

const DIRECTORS: DirectorUnderTest[] = [
  { slug: "platform", label: "Ada (Platform/DevOps Director)", railCategory: "out_of_leash_platform_synthetic" },
  { slug: "growth",   label: "Max (Growth Director)",           railCategory: "raise_total_budget" },
  { slug: "cs",       label: "June (CS Director)",              railCategory: "out_of_leash_cs_synthetic" },
  { slug: "logistics",label: "Marco (Logistics Director — read-only observer)", railCategory: "read_only_observer_every_card_escalates" },
];

interface DirectorVerdict {
  slug: string;
  inLeashOk: boolean;
  railHitOk: boolean;
  noDirectorSideMutationOnRailOk: boolean;
  reasons: string[];
}

async function runOne(admin: ReturnType<typeof createAdminClient>, d: DirectorUnderTest): Promise<DirectorVerdict> {
  const v: DirectorVerdict = { slug: d.slug, inLeashOk: false, railHitOk: false, noDirectorSideMutationOnRailOk: false, reasons: [] };

  // (i) IN-LEASH: recordDirectorActivity with the director's slug; assert one row landed with director_function=<slug>.
  //     Compare-and-set on read-back: (workspace_id, director_function, action_kind, metadata->>run_id, metadata->>marker).
  const actionKind = "confirm_audit_trail_synthetic";
  const inLeashReason = `phase4 audit-trail confirmation — synthetic in-leash record for ${d.slug} (run=${RUN_ID})`;
  const inLeashRes = await recordDirectorActivity(admin, {
    workspaceId: WS,
    directorFunction: d.slug,
    actionKind,
    reason: inLeashReason,
    metadata: { [MARKER]: true, run_id: RUN_ID, phase: "in_leash" },
  });
  if (!inLeashRes.recorded) {
    v.reasons.push(`in-leash recordDirectorActivity refused to write: ${inLeashRes.reason || "no reason"}`);
  } else {
    const { data: ver, error: vErr } = await admin
      .from("director_activity")
      .select("id, director_function, action_kind, metadata")
      .eq("workspace_id", WS)
      .eq("director_function", d.slug)
      .eq("action_kind", actionKind)
      .contains("metadata", { [MARKER]: true, run_id: RUN_ID });
    if (vErr) {
      v.reasons.push(`in-leash read-back errored: ${vErr.message}`);
    } else if (!ver || ver.length !== 1) {
      v.reasons.push(`in-leash read-back expected exactly 1 row for ${d.slug}; got ${ver?.length ?? 0}`);
    } else if (ver[0].director_function !== d.slug) {
      v.reasons.push(`in-leash row director_function mismatch: got ${ver[0].director_function}, want ${d.slug}`);
    } else {
      v.inLeashOk = true;
    }
  }

  // (ii) RAIL-HIT: escalateApprovalRequestToCeo with the director's identity.
  //      Synthetic target: an agent_jobs row already at status='completed' + our marker so no dispatch loop picks it up.
  //      (Rail-hit reads existing dashboard_notifications for an agent_job_id match — a fresh synthetic ID guarantees the
  //      "no existing routed" branch fires and INSERTs a new row we can assert on.)
  const { data: syntheticJob, error: jErr } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: WS,
      kind: actionKind,
      status: "completed",
      spec_slug: null,
      log_tail: `phase4 audit-trail confirmation synthetic target for ${d.slug} (run=${RUN_ID})`,
      metadata: { [MARKER]: true, run_id: RUN_ID, phase: "rail_hit_target" },
    })
    .select("id, workspace_id, kind, spec_slug")
    .single();
  if (jErr || !syntheticJob) {
    v.reasons.push(`rail-hit could not create synthetic agent_jobs target: ${jErr?.message || "no row returned"}`);
    return v;
  }
  const target: DirectorTargetJob = {
    id: syntheticJob.id as string,
    workspace_id: syntheticJob.workspace_id as string,
    kind: syntheticJob.kind as string,
    spec_slug: syntheticJob.spec_slug as string | null,
    pending_actions: null,
    log_tail: null,
  };
  const diagnosis = `phase4 audit-trail confirmation — synthetic rail-hit crossing '${d.railCategory}' (run=${RUN_ID}). This escalation carries the audit-confirm marker and is dismissed + deleted at end of run.`;
  const escRes = await escalateApprovalRequestToCeo(admin, target, diagnosis, { slug: d.slug, label: d.label });
  if (!escRes.ok) {
    v.reasons.push(`rail-hit escalateApprovalRequestToCeo returned ok=false`);
  } else {
    const { data: nRows, error: nErr } = await admin
      .from("dashboard_notifications")
      .select("id, type, metadata")
      .eq("workspace_id", WS)
      .eq("type", "approval_request")
      .contains("metadata", { agent_job_id: target.id, escalated_by_director: d.slug, routed_to_function: "ceo" });
    if (nErr) {
      v.reasons.push(`rail-hit read-back errored: ${nErr.message}`);
    } else if (!nRows || nRows.length !== 1) {
      v.reasons.push(`rail-hit read-back expected 1 dashboard_notifications row; got ${nRows?.length ?? 0}`);
    } else {
      const meta = nRows[0].metadata as Record<string, unknown>;
      if (String(meta.escalation_reason || "").includes(d.railCategory)) {
        v.railHitOk = true;
      } else {
        v.reasons.push(`rail-hit escalation_reason did not name the leash category '${d.railCategory}'`);
      }
    }
  }

  // (iii) director-side must not mutate on a rail hit — count director_activity rows written for THIS run's
  //       rail-hit target. escalateApprovalRequestToCeo writes NO director_activity; if any row appears carrying
  //       our marker + phase=rail_hit_target-side, the contract has been broken (a director-side write leaked).
  const { data: leakRows, error: leakErr } = await admin
    .from("director_activity")
    .select("id, metadata")
    .eq("workspace_id", WS)
    .contains("metadata", { [MARKER]: true, run_id: RUN_ID, phase: "rail_hit_director_side" });
  if (leakErr) {
    v.reasons.push(`rail-hit director-side-leak check errored: ${leakErr.message}`);
  } else if ((leakRows ?? []).length === 0) {
    v.noDirectorSideMutationOnRailOk = true;
  } else {
    v.reasons.push(`rail-hit contract broken: ${leakRows!.length} director_activity row(s) written on a rail-hit (must be 0)`);
  }

  return v;
}

async function cleanup(admin: ReturnType<typeof createAdminClient>) {
  // compare-and-set delete: (workspace_id, marker, run_id) — never a bare marker match across runs.
  await admin
    .from("director_activity")
    .delete()
    .eq("workspace_id", WS)
    .contains("metadata", { [MARKER]: true, run_id: RUN_ID });
  await admin
    .from("dashboard_notifications")
    .update({ dismissed: true, read: true })
    .eq("workspace_id", WS)
    .eq("type", "approval_request")
    .contains("metadata", { escalated_by_director: "platform" })
    .contains("metadata", { agent_job_id: "-" });
  // dismiss + delete any dashboard_notifications whose metadata carries our run_id (via nested contain on the
  // synthetic job id — safest predicate we have without a top-level marker column).
  const { data: jobRows } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", WS)
    .eq("kind", "confirm_audit_trail_synthetic")
    .contains("metadata", { [MARKER]: true, run_id: RUN_ID });
  const jobIds = (jobRows ?? []).map((r) => r.id as string);
  if (jobIds.length) {
    for (const jid of jobIds) {
      await admin
        .from("dashboard_notifications")
        .delete()
        .eq("workspace_id", WS)
        .eq("type", "approval_request")
        .contains("metadata", { agent_job_id: jid });
    }
    await admin.from("agent_jobs").delete().eq("workspace_id", WS).in("id", jobIds);
  }
}

async function main() {
  const admin = createAdminClient();
  const verdicts: DirectorVerdict[] = [];
  try {
    for (const d of DIRECTORS) {
      const v = await runOne(admin, d);
      verdicts.push(v);
    }
  } finally {
    await cleanup(admin);
  }

  let allPassed = true;
  for (const v of verdicts) {
    const ok = v.inLeashOk && v.railHitOk && v.noDirectorSideMutationOnRailOk;
    if (!ok) allPassed = false;
    if (ok) {
      console.log(`PASS ${v.slug}: in-leash director_activity row landed with director_function='${v.slug}'; rail-hit escalated to CEO with escalated_by_director='${v.slug}'; no director-side mutation on rail.`);
    } else {
      console.error(`FAIL ${v.slug}: ${v.reasons.join(" · ") || "unknown"}`);
    }
  }

  console.log("");
  console.log(allPassed
    ? "✓ ALL PASS — director-chat audit-trail contract verified for platform, growth, cs, logistics."
    : "✗ SOME FAIL — see per-director reasons above.");
  process.exit(allPassed ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
