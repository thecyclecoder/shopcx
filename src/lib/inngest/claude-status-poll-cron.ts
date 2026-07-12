/**
 * claude-status-poll-cron — the external-truth half of the Claude-down circuit-breaker
 * (agent-outage-resilience spec, Phase 2).
 *
 * Every minute: poll status.claude.com/api/v2/components.json and persist the per-component status of
 * "Claude API (api.anthropic.com)" + "Claude Code" onto the `claude_health` singleton, recomputing the
 * combined breaker. A partial/major outage on either component trips the breaker (→ the box parks
 * autonomous agent jobs `blocked_on_dependency`; recordError suppresses the repair fan-out). A poll we
 * can't complete leaves the external signal untouched (unreachable ≠ down).
 *
 * See [[../libraries/claude-health]] · docs/brain/specs/agent-outage-resilience.md.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshClaudeHealthFromStatus } from "@/lib/claude-health";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const claudeStatusPollCron = inngest.createFunction(
  {
    id: "claude-status-poll-cron",
    retries: 1, // the next tick re-polls a minute later — no value in long retries on a status poll
    triggers: [{ cron: "*/5 * * * *" }], // every 5 min (CEO 2026-07-11 monitoring-cost guardrail: MONITOR_TICK_FLOOR_MS)
  },
  async ({ step }) => {
    const result = await step.run("poll-claude-status", async () => {
      const admin = createAdminClient();
      const h = await refreshClaudeHealthFromStatus(admin);
      return {
        api: h.apiStatus,
        code: h.codeStatus,
        externalDown: h.externalDown,
        localDown: h.localDown,
        breakerOpen: h.down,
        pollOk: h.pollOk,
      };
    });
    // Heartbeat ok = the poll completed; a tripped breaker is a real signal, not a cron failure.
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("claude-status-poll-cron", { ok: result.pollOk !== false, produced: result });
    });
    return result;
  },
);
