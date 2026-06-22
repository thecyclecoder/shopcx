/**
 * Slack Roadmap Console — status push watcher (Phase 5).
 *
 * A cron that diffs `agent_jobs` against a `slack_notified_status` marker and posts build-status
 * transitions into the #roadmap channel. All Slack logic stays in the Vercel app; the box worker
 * stays Slack-unaware (it just drives the queue). Cron over Realtime = simplest, and the latency
 * matches the dashboard's existing poll model.
 *
 * Posts on transitions into: needs_input, needs_approval, completed, failed, needs_attention.
 * Dedup: only when `status != slack_notified_status`; sets the marker after a successful post.
 * A 15-minute `updated_at` window guards against a cold-start flood of historical terminal jobs.
 *
 * See docs/brain/specs/slack-roadmap-console-run-the-build-console-from-slack.md.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSlackToken, findChannelByName, postMessage } from "@/lib/slack";
import { getSpec } from "@/lib/brain-roadmap";
import { buildStatusPushMessage } from "@/lib/slack-roadmap";
import type { AgentJob } from "@/lib/agent-jobs";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

const NOTIFY_STATUSES = ["needs_input", "needs_approval", "completed", "failed", "needs_attention"];
const ROADMAP_CHANNEL = "roadmap"; // the private #roadmap channel the bot was invited to
const WINDOW_MS = 15 * 60 * 1000; // ignore transitions older than this (cold-start flood guard)
const MAX_PER_RUN = 25; // bound message volume per workspace per tick

export const slackRoadmapNotify = inngest.createFunction(
  { id: "slack-roadmap-notify", retries: 1, triggers: [{ cron: "* * * * *" }] }, // every minute (cron's finest granularity)
  async () => {
    const admin = createAdminClient();
    const since = new Date(Date.now() - WINDOW_MS).toISOString();

    // Workspaces with Slack connected. (Build console is effectively single-tenant, but iterate.)
    const { data: workspaces } = await admin
      .from("workspaces")
      .select("id")
      .not("slack_bot_token_encrypted", "is", null);

    let posted = 0;
    for (const ws of workspaces || []) {
      try {
        const token = await getSlackToken(ws.id);
        if (!token) continue;
        const channel = await findChannelByName(token, ROADMAP_CHANNEL);
        if (!channel) continue; // bot not in a #roadmap channel here → nothing to push

        // Recently-transitioned jobs whose marker hasn't caught up to their current status.
        const { data: jobs } = await admin
          .from("agent_jobs")
          .select("*")
          .eq("workspace_id", ws.id)
          .in("status", NOTIFY_STATUSES)
          .gte("updated_at", since)
          .order("updated_at", { ascending: true })
          .limit(MAX_PER_RUN);

        for (const job of (jobs || []) as AgentJob[]) {
          const marker = (job as AgentJob & { slack_notified_status?: string | null }).slack_notified_status;
          if (marker === job.status) continue; // already announced this transition

          const found = await getSpec(job.spec_slug);
          const msg = buildStatusPushMessage(job.spec_slug, found?.card ?? null, job);
          if (!msg) continue;

          const ok = await postMessage(token, channel, msg.blocks, msg.text);
          if (!ok) continue; // leave the marker so we retry next tick

          await admin.from("agent_jobs").update({ slack_notified_status: job.status }).eq("id", job.id);
          posted += 1;
        }
      } catch (err) {
        console.error(`[slack-roadmap-notify] workspace ${ws.id} error:`, err);
      }
    }

    const result = { posted };
    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await emitCronHeartbeat("slack-roadmap-notify", { ok: true, produced: result });
    return result;
  },
);
