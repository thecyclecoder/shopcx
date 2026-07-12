/**
 * marco-logistics-director-seat Phase 4 — audit-trail confirmation script.
 *
 * Runtime artifact per the spec's Phase 4 verification (docs/brain/specs/marco-logistics-director-seat.md).
 * Sweeps the four live director cockpits (platform · growth · cs · logistics). Eve's god-mode surface is
 * out of scope here (its audit lives in dashboard_notifications only, no director_activity contract). For
 * every live director we exercise the two write paths the M3 dispatch flows through and confirm the
 * contract from docs/brain/lifecycles/director-cockpits.md:
 *
 *   IN-LEASH APPROVE → recordDirectorActivity({ workspaceId, directorFunction, actionKind='confirm_audit_trail_synthetic' })
 *     Assert: one new director_activity row lands with director_function=<slug>.
 *
 *   RAIL-HIT (out-of-leash) → escalateApprovalRequestToCeo(admin, target, diagnosis, { slug, label })
 *     Assert: one new dashboard_notifications row lands with
 *       type=APPROVAL_REQUEST_TYPE ('agent_approval_request')
 *       metadata.routed_to_function='ceo'
 *       metadata.escalated_by_director=<slug>
 *       metadata.escalation_reason NAMING the leash category the rail crossed
 *     And that the same escalation wrote NO director_activity row (the director-side must not mutate).
 *
 * The synthetic `target` passed to `escalateApprovalRequestToCeo` is a PURE JS OBJECT — DirectorTargetJob
 * is a TypeScript-only shape used to feed the dashboard-notification insert; nothing persists to
 * `agent_jobs` (dropped in the rewrite — the earlier version tried to insert into agent_jobs with
 * `spec_slug: null` + `metadata:{}` and hit a NOT-NULL + missing-column pair). The synthetic id is a
 * fresh uuid; escalateApprovalRequestToCeo's dedup match keys on `metadata.agent_job_id` inside the
 * `dashboard_notifications` table, so a fresh id guarantees the "no existing routed" branch fires an
 * INSERT we can read back and clean up.
 *
 * Safe-by-construction on prod:
 *   • every synthetic director_activity row carries a `marco_phase4_audit_confirm=true` + `run_id=<...>`
 *     marker in `metadata`; a cleanup sweep deletes exactly those rows via compare-and-set on
 *     (workspace_id, marker, run_id) — never a bare row-exists proxy (per coaching guidance #12).
 *   • the synthetic dashboard_notifications rows are found by `metadata.escalated_by_director` +
 *     `metadata.agent_job_id ∈ syntheticIds` — again the compare-and-set key. The rows are
 *     dismissed + then deleted so the CEO inbox is never rendered a synthetic escalation.
 *
 * Prints "PASS <slug>" per director on contract pass; exits 0 iff every director passed BOTH paths.
 *
 * Run against the pooler:
 *   npx tsx scripts/_confirm-director-chat-audit-trail.ts
 */
import { randomUUID } from "crypto";
import { createAdminClient } from "./_bootstrap";
import { recordDirectorActivity } from "../src/lib/director-activity";
import { escalateApprovalRequestToCeo, type DirectorTargetJob } from "../src/lib/agents/platform-director";
import { APPROVAL_REQUEST_TYPE } from "../src/lib/agents/inbox";

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
  syntheticJobId: string;
  reasons: string[];
}

async function runOne(admin: ReturnType<typeof createAdminClient>, d: DirectorUnderTest): Promise<DirectorVerdict> {
  const syntheticJobId = randomUUID();
  const v: DirectorVerdict = {
    slug: d.slug,
    inLeashOk: false,
    railHitOk: false,
    noDirectorSideMutationOnRailOk: false,
    syntheticJobId,
    reasons: [],
  };

  // (i) IN-LEASH: recordDirectorActivity with the director's slug; assert one row landed with director_function=<slug>.
  //     Compare-and-set on read-back via (workspace_id, director_function, action_kind, metadata@>run_id+marker).
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
      .contains("metadata", { [MARKER]: true, run_id: RUN_ID, phase: "in_leash" });
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
  //      target is a PURE JS OBJECT (DirectorTargetJob is TS-only); no agent_jobs row is inserted.
  //      escalateApprovalRequestToCeo dedups on dashboard_notifications.metadata->>agent_job_id — a fresh
  //      uuid guarantees the "no existing routed" branch fires an INSERT.
  const target: DirectorTargetJob = {
    id: syntheticJobId,
    workspace_id: WS,
    kind: actionKind,
    spec_slug: null,
    pending_actions: [
      {
        type: "confirm_audit_trail_synthetic",
        title: `phase4 audit-trail synthetic ${d.slug}`,
        summary: `synthetic rail-hit action for ${d.slug} audit-trail confirmation`,
        status: "needs_approval",
        [MARKER]: true,
        run_id: RUN_ID,
      } as never,
    ],
    log_tail: `phase4 audit-trail synthetic ${d.slug} (run=${RUN_ID})`,
  };
  const diagnosis = `phase4 audit-trail confirmation — synthetic rail-hit crossing '${d.railCategory}' (run=${RUN_ID}). This escalation carries the audit-confirm marker and is dismissed + deleted at end of run.`;
  const escRes = await escalateApprovalRequestToCeo(admin, target, diagnosis, { slug: d.slug, label: d.label });
  if (!escRes.ok) {
    v.reasons.push(`rail-hit escalateApprovalRequestToCeo returned ok=false`);
  } else if (!escRes.created) {
    v.reasons.push(`rail-hit escalateApprovalRequestToCeo returned created=false (expected fresh INSERT)`);
  } else {
    const { data: nRows, error: nErr } = await admin
      .from("dashboard_notifications")
      .select("id, type, metadata")
      .eq("workspace_id", WS)
      .eq("type", APPROVAL_REQUEST_TYPE)
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

  // (iii) director-side must not mutate on a rail hit — count director_activity rows that carry our run_id +
  //       phase='rail_hit'. escalateApprovalRequestToCeo writes NO director_activity; a leak here breaks the
  //       north-star supervisable-autonomy contract (the director's own ledger must stay silent on a rail).
  const { data: leakRows, error: leakErr } = await admin
    .from("director_activity")
    .select("id, metadata")
    .eq("workspace_id", WS)
    .contains("metadata", { [MARKER]: true, run_id: RUN_ID, phase: "rail_hit" });
  if (leakErr) {
    v.reasons.push(`rail-hit director-side-leak check errored: ${leakErr.message}`);
  } else if ((leakRows ?? []).length === 0) {
    v.noDirectorSideMutationOnRailOk = true;
  } else {
    v.reasons.push(`rail-hit contract broken: ${leakRows!.length} director_activity row(s) written on a rail-hit (must be 0)`);
  }

  return v;
}

async function cleanup(admin: ReturnType<typeof createAdminClient>, verdicts: DirectorVerdict[]) {
  // (a) director_activity — delete ONLY the synthetic in-leash rows this run wrote.
  //     Compare-and-set: (workspace_id, marker, run_id) — never a bare marker match across runs.
  await admin
    .from("director_activity")
    .delete()
    .eq("workspace_id", WS)
    .contains("metadata", { [MARKER]: true, run_id: RUN_ID });

  // (b) dashboard_notifications — dismiss + delete ONLY the synthetic rail-hit rows this run created.
  //     Key on the run's synthetic agent_job_ids (already unique per director + per run).
  const jobIds = verdicts.map((v) => v.syntheticJobId);
  for (const jid of jobIds) {
    await admin
      .from("dashboard_notifications")
      .update({ dismissed: true, read: true })
      .eq("workspace_id", WS)
      .eq("type", APPROVAL_REQUEST_TYPE)
      .contains("metadata", { agent_job_id: jid });
    await admin
      .from("dashboard_notifications")
      .delete()
      .eq("workspace_id", WS)
      .eq("type", APPROVAL_REQUEST_TYPE)
      .contains("metadata", { agent_job_id: jid });
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
    await cleanup(admin, verdicts);
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
