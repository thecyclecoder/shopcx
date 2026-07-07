/**
 * cs-director-digest-composer — the weekly composer cron behind [[../tables/cs_director_digests]].
 *
 * Phase 1 of [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]]. Runs
 * once a week (Monday 14:00 UTC) and, for every workspace with any CS-director action or resolution-
 * event activity in the previous 7 days, composes ONE storyline digest via
 * [[../libraries/cs-director-digest]] `composeCsDirectorDigest`.
 *
 * The workspace filter is deliberately WIDE (any cs_director_call verdict OR any resolution event in
 * the window): a quiet week still emits a digest with zero storylines rather than silently skipping —
 * the founder surface (Phase 2) needs a stable "did the week compose?" signal, not an inferred absence.
 *
 * Idempotent per (workspace, digest_period_start) — the composer's own idempotency check makes the
 * `retries:1` retry safe. Ends with a Control Tower heartbeat so a dead composer is visible.
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { composeCsDirectorDigest } from "@/lib/cs-director-digest";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Return the ISO timestamps that bound the digest period ending at `nowIso`. `since` is 7 days back,
 * `until` is `nowIso` — exclusive at the tail so successive weekly runs never double-count a row.
 */
function periodBoundsEndingAt(nowIso: string): { since: string; until: string } {
  const now = new Date(nowIso);
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  return { since, until: now.toISOString() };
}

export const csDirectorDigestComposerCron = inngest.createFunction(
  {
    id: "cs-director-digest-composer",
    retries: 1,
    // Weekly — Monday 14:00 UTC (early US-business-hours Monday, so the founder reads the digest with
    // the fresh week ahead rather than lagged past midnight). See docs/brain/inngest/cs-director-digest-composer.md.
    triggers: [{ cron: "0 14 * * 1" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();
    const runAt = new Date().toISOString();
    const { since, until } = periodBoundsEndingAt(runAt);

    // Find every workspace with any CS-director-call verdict OR ticket_resolution_event in the window.
    // Wide on purpose: a quiet week still emits an empty-storylines digest (see the file header).
    const workspaces = await step.run("find-workspaces-with-activity", async () => {
      const ids = new Set<string>();
      const [verdicts, events] = await Promise.all([
        admin
          .from("director_activity")
          .select("workspace_id")
          .eq("director_function", "cs")
          .eq("action_kind", "cs_director_call")
          .gte("created_at", since)
          .lt("created_at", until),
        admin
          .from("ticket_resolution_events")
          .select("workspace_id")
          .gte("staged_at", since)
          .lt("staged_at", until)
          .limit(5000),
      ]);
      for (const r of [...(verdicts.data ?? []), ...(events.data ?? [])]) {
        if (r.workspace_id) ids.add(r.workspace_id as string);
      }
      return Array.from(ids);
    });

    let composed = 0;
    let skipped = 0;
    let alreadyPresent = 0;
    for (const workspaceId of workspaces) {
      const r = await step.run(`compose-${workspaceId}`, async () => {
        try {
          return await composeCsDirectorDigest(admin, workspaceId, since, until);
        } catch (err) {
          console.error("[cs-director-digest-composer] compose error:", err);
          return { inserted: false, row: null, storylineCount: 0 };
        }
      });
      if (r.inserted) composed++;
      else if (r.row) alreadyPresent++;
      else skipped++;
    }

    const result = {
      period_start: since,
      period_end: until,
      workspaces: workspaces.length,
      composed,
      already_present: alreadyPresent,
      skipped,
    };

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("cs-director-digest-composer", { ok: true, produced: result });
    });

    return result;
  },
);
