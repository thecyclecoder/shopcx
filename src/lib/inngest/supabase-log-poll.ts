/**
 * supabase-log-poll cron — pull DB-level Supabase errors into the Control Tower
 * (error-feed-monitoring Phase 2).
 *
 * Every ~15 min it polls the Supabase Management Logs API (logs.all) for the error
 * rows our own app code never sees — Postgres ERROR/FATAL/PANIC, auth-service errors,
 * edge API 5xxs — and records them grouped into error_events under source='supabase-logs'
 * (its own dashboard panel), paging owners on a new signature / spike (rate-limited).
 *
 * A no-op until the owner pastes a Supabase access token (the lone owner setup of this
 * spec); all the work lives in src/lib/control-tower/supabase-log-poll.ts. Registered as
 * a monitored cron (registry.ts) and emits its own heartbeat so a dead poller is visible.
 *
 * See docs/brain/inngest/supabase-log-poll.md · docs/brain/integrations/supabase-management-logs.md.
 */
import { inngest } from "@/lib/inngest/client";
import { pollSupabaseLogs } from "@/lib/control-tower/supabase-log-poll";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const supabaseLogPollCron = inngest.createFunction(
  {
    id: "supabase-log-poll-cron",
    name: "Control Tower — Supabase Management Logs poll",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async ({ step }) => {
    const startedAt = Date.now();
    const result = await step.run("poll-supabase-logs", async () => pollSupabaseLogs());

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("supabase-log-poll-cron", {
        // 'no-token' is healthy (not yet configured); a total query failure is not.
        ok: result.status !== "error",
        produced: result,
        detail:
          result.status === "no-token"
            ? "no Supabase access token configured (no-op)"
            : `${result.incidents} incidents · ${result.rows} rows${result.errors.length ? ` · errors: ${result.errors.join("; ").slice(0, 200)}` : ""}`,
        durationMs: Date.now() - startedAt,
      });
    });

    return result;
  },
);
