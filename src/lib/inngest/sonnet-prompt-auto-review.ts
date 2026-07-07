/**
 * Daily enqueue cron for the sonnet-prompt auto-review box agent.
 *
 * Cron expression `0 11 * * *` = 11:00 UTC = 6 AM Central (during CDT),
 * right after the daily-report-cron.
 *
 * The reviewer USED to be a headless Claude Opus API call fired from
 * this cron (a raw-API cron optimizing a proxy with no objective-owner —
 * the anti-pattern the operational-rules § North star names). The
 * reviewer is now a supervised box-session agent
 * (kind='prompt-review') under June (CS Director) — see
 * docs/brain/specs/prompt-auto-review-becomes-box-agent-under-june.md.
 *
 * What this cron does now:
 *   1. Enumerate workspaces with `sonnet_auto_review_enabled=true`.
 *   2. For each, list the workspace's `status='proposed'` +
 *      `auto_decision IS NULL` prompts (oldest first, capped by
 *      MAX_PROPOSALS_PER_CRON_RUN so a large backlog drains over
 *      consecutive days rather than flooding the box).
 *   3. Insert one `agent_jobs` row (kind='prompt-review',
 *      spec_slug=proposal.id) per proposal that DOESN'T already have
 *      an in-flight prompt-review job (dedupe against queued /
 *      queued_resume / building / claimed / needs_attention — same
 *      shape as [[triage-escalations]]).
 *
 * The box worker (scripts/builder-worker.ts → runPromptReviewJob) is
 * the only component that ACTUALLY runs a review — it emits a
 * per-proposal verdict as an agent session (reasoning surfaced) and
 * the deterministic runner writes status + auto_decision fields via
 * `applyDecision` (unchanged safety guards: REJECT_FLOOR, daily cap,
 * audit-first, supersede-not-delete). No code path calls
 * api.anthropic.com directly anymore.
 *
 * Concurrency 1 — at most one enqueue-sweep runs at a time; the
 * enqueue itself is cheap (a few SELECTs + INSERTs), the review
 * work is on the box lane.
 *
 * See docs/brain/inngest/sonnet-prompt-auto-review.md +
 * docs/brain/lifecycles/ai-learning.md (the closed loop).
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { MAX_PROPOSALS_PER_CRON_RUN } from "@/lib/sonnet-prompt-auto-review";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

// The agent_jobs statuses that count as "already in flight" for
// dedupe: anything not concluded. A concluded job (completed /
// failed / needs_attention→dismissed) frees the proposal for the
// next tick's enqueue.
const IN_FLIGHT_STATUSES = ["queued", "queued_resume", "claimed", "building", "needs_attention"] as const;

export const sonnetPromptAutoReviewCron = inngest.createFunction(
  {
    id: "sonnet-prompt-auto-review",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: "0 11 * * *" },
      // Manual trigger — fire `prompt-learning/auto-review.run` to invoke
      // out of band (Inngest dashboard "Invoke", or `inngest.send` from
      // anywhere in the codebase). Used for one-off runs after the
      // human-review backlog gets cleared so we don't have to wait
      // for the next 11 UTC tick.
      { event: "prompt-learning/auto-review.run" },
    ],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaces = await step.run("find-enabled-workspaces", async () => {
      const { data } = await admin
        .from("workspaces")
        .select("id, name")
        .eq("sonnet_auto_review_enabled", true);
      return data || [];
    });

    let totalEnqueued = 0;
    let totalCandidates = 0;
    let totalSkipped = 0;
    const perWorkspace: Array<{ workspace_id: string; name: string; candidates: number; enqueued: number; skipped: number }> = [];
    const errors: string[] = [];

    for (const ws of workspaces) {
      const r = await step.run(`enqueue-${ws.id}`, async () => {
        const workspaceId = ws.id as string;

        // 1. Backlog for this workspace — proposals that haven't been
        //    reviewed yet, oldest first, capped so a large workspace
        //    doesn't monopolize the box lane in one tick.
        const { data: proposals, error: pErr } = await admin
          .from("sonnet_prompts")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("status", "proposed")
          .is("auto_decision", null)
          .order("proposed_at", { ascending: true })
          .limit(MAX_PROPOSALS_PER_CRON_RUN);
        if (pErr) return { candidates: 0, enqueued: 0, skipped: 0, error: `proposals_select_failed: ${pErr.message}` };
        if (!proposals?.length) return { candidates: 0, enqueued: 0, skipped: 0 };

        const proposalIds = proposals.map((p) => p.id as string);

        // 2. Dedupe — any of these already have an in-flight
        //    kind='prompt-review' job? spec_slug carries the
        //    proposal id (same shape spec-review uses for its
        //    per-spec anchor).
        const { data: inflight, error: iErr } = await admin
          .from("agent_jobs")
          .select("spec_slug")
          .eq("workspace_id", workspaceId)
          .eq("kind", "prompt-review")
          .in("status", IN_FLIGHT_STATUSES as unknown as string[])
          .in("spec_slug", proposalIds);
        if (iErr) return { candidates: proposalIds.length, enqueued: 0, skipped: 0, error: `inflight_select_failed: ${iErr.message}` };
        const busy = new Set((inflight || []).map((j) => j.spec_slug as string));

        // 3. Enqueue one row per fresh proposal.
        let enqueued = 0;
        let skipped = 0;
        for (const proposalId of proposalIds) {
          if (busy.has(proposalId)) {
            skipped++;
            continue;
          }
          const { error: insErr } = await admin.from("agent_jobs").insert({
            workspace_id: workspaceId,
            spec_slug: proposalId,
            kind: "prompt-review",
            status: "queued",
            created_by: null,
          });
          if (insErr) return { candidates: proposalIds.length, enqueued, skipped, error: `insert_failed on ${proposalId}: ${insErr.message}` };
          enqueued++;
        }
        return { candidates: proposalIds.length, enqueued, skipped };
      });
      perWorkspace.push({ workspace_id: ws.id as string, name: (ws as { name?: string }).name || "", candidates: r.candidates, enqueued: r.enqueued, skipped: r.skipped });
      totalCandidates += r.candidates;
      totalEnqueued += r.enqueued;
      totalSkipped += r.skipped;
      if ("error" in r && r.error) errors.push(`${ws.id}: ${r.error}`);
    }

    const result = {
      workspaces: workspaces.length,
      candidates: totalCandidates,
      enqueued: totalEnqueued,
      skipped: totalSkipped,
      perWorkspace,
      errors: errors.slice(0, 50),
    };

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    // Emit AFTER the workspace loop even when nothing was enqueued — a healthy-but-idle
    // cron must still beat (docs/brain/operational-rules.md § heartbeats).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("sonnet-prompt-auto-review", { ok: true, produced: result });
    });

    return result;
  },
);
