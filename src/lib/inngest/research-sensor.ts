/**
 * Rhea's research-sensor cron — the paced hourly claim of the top-spend unreviewed research URL
 * (docs/brain/specs/rhea-research-automation.md, Phase 1). Makes Rhea's research pipeline run
 * UNATTENDED and STRICTLY one-at-a-time.
 *
 * Per workspace with an ad tool wired up:
 *   1. sync — pull any new scout destinations into research_urls (idempotent — same upsert path
 *      the daily creative-finder cron feeds; see [[../libraries/research-urls]]).
 *   2. claim — pick the NEXT unreviewed URL: `classification IS NULL AND teardown_verdict='unreviewed'`
 *      ordered by `ad_count DESC, first_seen ASC` — investigate the landers competitors spend the
 *      MOST behind first, tiebroken by earliest sighting.
 *   3. dedup — if a `research` agent_jobs row is already `queued`/`queued_resume`/`building`/`claimed`
 *      for this workspace, SKIP this tick. True one-at-a-time: no second job piles on the box.
 *   4. enqueue — one `research` job carrying the URL id in `instructions` (JSON `{research_url_id}`)
 *      so the box lane can pick it up unambiguously; the deterministic worker still batches by
 *      ad_count DESC, so the claimed URL is guaranteed to be in-scope for the run it triggers.
 *
 * Every step is best-effort per workspace — a failure on one never wedges the sweep. Ends with a
 * Control Tower heartbeat so a healthy-but-idle beat still lands ([[../libraries/control-tower/heartbeat]]).
 *
 * This SUPERSEDES the slice-1 stub in [[acquisition-research-cadence]] that enqueued a `research`
 * job once a day — the hourly claim-by-spend is now the real trigger (paced, supervised, auditable).
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncResearchUrlsFromCreatives } from "@/lib/research-urls";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

async function adToolWorkspaceIds(): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("ad_campaigns").select("workspace_id");
  return Array.from(new Set((data || []).map((r) => r.workspace_id as string)));
}

interface WorkspaceSensorResult {
  workspaceId: string;
  synced: { distinct: number; upserted: number };
  claim: { research_url_id: string; ad_count: number } | null;
  enqueued: 0 | 1;
  skipReason: null | "in-flight" | "no-unreviewed";
}

/** One workspace's sync + claim + enqueue pass. */
async function runWorkspaceSensor(workspaceId: string): Promise<WorkspaceSensorResult> {
  const admin = createAdminClient();
  const result: WorkspaceSensorResult = {
    workspaceId,
    synced: { distinct: 0, upserted: 0 },
    claim: null,
    enqueued: 0,
    skipReason: null,
  };

  try {
    const s = await syncResearchUrlsFromCreatives(workspaceId);
    result.synced = { distinct: s.distinct, upserted: s.upserted };
  } catch (err) {
    console.error(`[research-sensor] sync failed ws=${workspaceId}:`, err);
  }

  // Dedup FIRST — cheap, avoids picking a URL we won't enqueue anyway. Skip if any research
  // job for this workspace is already in flight (queued / queued_resume / building / claimed).
  try {
    const { data: inflight } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("kind", "research")
      .in("status", ["queued", "queued_resume", "building", "claimed"])
      .limit(1);
    if (inflight && inflight.length) {
      result.skipReason = "in-flight";
      return result;
    }
  } catch (err) {
    console.error(`[research-sensor] inflight probe failed ws=${workspaceId}:`, err);
    // Fail closed on a probe error: don't enqueue if we can't verify no in-flight job exists.
    result.skipReason = "in-flight";
    return result;
  }

  // Pick the next claimable row: unclassified + unreviewed, biggest ad_count first.
  try {
    const { data: rows } = await admin
      .from("research_urls")
      .select("id, ad_count")
      .eq("workspace_id", workspaceId)
      .is("classification", null)
      .eq("teardown_verdict", "unreviewed")
      .order("ad_count", { ascending: false })
      .order("first_seen", { ascending: true })
      .limit(1);
    const row = rows && rows[0];
    if (!row) {
      result.skipReason = "no-unreviewed";
      return result;
    }
    result.claim = { research_url_id: row.id as string, ad_count: (row.ad_count as number) ?? 0 };
  } catch (err) {
    console.error(`[research-sensor] claim query failed ws=${workspaceId}:`, err);
    return result;
  }

  // Enqueue ONE research job carrying the URL id (spec Phase 1 step 4).
  try {
    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: "research",
      kind: "research",
      status: "queued",
      created_by: null,
      instructions: JSON.stringify({ research_url_id: result.claim.research_url_id }),
    });
    if (error) {
      console.error(`[research-sensor] enqueue failed ws=${workspaceId}: ${error.message}`);
      return result;
    }
    result.enqueued = 1;
  } catch (err) {
    console.error(`[research-sensor] enqueue threw ws=${workspaceId}:`, err);
  }
  return result;
}

export const researchSensorCron = inngest.createFunction(
  { id: "research-sensor-cron", retries: 1, triggers: [{ cron: "0 * * * *" }] },
  async ({ step }) => {
    const result = await (async () => {
      const workspaceIds = await step.run("ad-tool-workspaces", adToolWorkspaceIds);
      if (!workspaceIds.length) return { workspaces: 0, results: [] as WorkspaceSensorResult[] };
      const results: WorkspaceSensorResult[] = [];
      for (const workspaceId of workspaceIds) {
        const r = await step.run(`sensor-${workspaceId}`, () => runWorkspaceSensor(workspaceId));
        results.push(r);
      }
      const enqueued = results.reduce((n, r) => n + r.enqueued, 0);
      return { workspaces: workspaceIds.length, enqueued, results };
    })();

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("research-sensor-cron", { ok: true, produced: result });
    });

    return result;
  },
);
