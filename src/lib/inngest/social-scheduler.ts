/**
 * Automated organic social scheduler — planner cron + per-post publisher.
 * See docs/brain/specs/automated-social-scheduler.md.
 *
 * Planner (daily cron): keeps each enabled workspace's calendar filled to a
 * rolling 7-day horizon. Stories daily, feeds 4×/wk, reels 3×/wk (deterministic
 * by weekday). Picks a source asset (rotating, recent-reuse-aware), generates a
 * PI-grounded caption, inserts scheduled_social_posts rows, and fires a
 * `social/publish` event per row.
 *
 * Publisher (per post): sleepUntil(scheduled_at) → re-read (honors edits/cancel)
 * → publish via the Graph API → record result.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { pickBySourceKind, type SourceKind } from "@/lib/social/resources";
import { generateCaption, type PostType } from "@/lib/social/generate-caption";
import { publishScheduledPost, type ScheduledPostRow } from "@/lib/social/publish";
import { loadSlotSignals, pickBestSlot } from "@/lib/social/optimizer";

function localHourOf(iso: string, tz: string): number {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date(iso)));
  return h === 24 ? 0 : h;
}

interface SchedulerConfig {
  enabled: boolean;
  require_approval: boolean;
  timezone: string;
  cadence: { reel: number; feed: number; story: number };
  time_slots: { feed: string[]; reel: string[]; story: string[] };
  min_resource_reuse_days: number;
  target_meta_page_ids?: string[];
  max_posts_per_platform_per_day?: number;  // hard guardrail; start conservative
}

const HORIZON_DAYS = 7;

/** Wall-clock local time (YYYY-MM-DD + "HH:mm" in an IANA tz) → UTC Date. */
function zonedToUtc(dateStr: string, hhmm: string, tz: string): Date {
  const guess = new Date(`${dateStr}T${hhmm}:00Z`); // first treat the wall time as UTC
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(guess)) m[p.type] = p.value;
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +(m.hour === "24" ? "0" : m.hour), +m.minute, +m.second);
  return new Date(guess.getTime() - (asUtc - guess.getTime()));
}

// Which source kind feeds each post type (rotates by day so it varies).
function kindForType(postType: PostType, dayNum: number): SourceKind {
  if (postType === "reel") return "ad_video";
  if (postType === "feed") return (["avatar", "testimonial", "resource"] as SourceKind[])[dayNum % 3];
  return (["avatar", "testimonial"] as SourceKind[])[dayNum % 2]; // story (image)
}

export async function planWorkspace(workspaceId: string, config: SchedulerConfig): Promise<number> {
  if (!config.enabled || !config.target_meta_page_ids?.length) return 0;
  const admin = createAdminClient();
  const tz = config.timezone || "America/Chicago";
  const reuseDays = config.min_resource_reuse_days ?? 21;
  const dailyCap = config.max_posts_per_platform_per_day ?? 3;  // start at ≤3/platform/day

  const { data: pages } = await admin
    .from("meta_pages")
    .select("id, platform, is_active")
    .in("id", config.target_meta_page_ids)
    .eq("is_active", true);
  const igPages = (pages || []).filter((p) => p.platform === "instagram");
  const fbPages = (pages || []).filter((p) => p.platform === "facebook");
  if (!igPages.length && !fbPages.length) return 0;

  // Timing optimizer signals (audience-online × our own engagement-by-hour).
  const signals = await loadSlotSignals(admin, workspaceId, tz);

  let created = 0;
  for (let d = 1; d <= HORIZON_DAYS; d++) {
    const date = new Date(Date.now() + d * 86_400_000);
    const dateStr = date.toISOString().slice(0, 10);
    const dow = date.getUTCDay();             // 0 Sun … 6 Sat
    const dayNum = Math.floor(date.getTime() / 86_400_000);

    // Per-platform daily cap — seed from anything already on the calendar that day.
    const dayStartIso = `${dateStr}T00:00:00Z`, dayEndIso = `${dateStr}T23:59:59Z`;
    const { data: dayRows } = await admin
      .from("scheduled_social_posts")
      .select("platform, meta_page_id, scheduled_at")
      .eq("workspace_id", workspaceId)
      .gte("scheduled_at", dayStartIso).lte("scheduled_at", dayEndIso)
      .neq("status", "cancelled");
    const dayCount: Record<string, number> = { facebook: 0, instagram: 0 };
    const takenByPage = new Map<string, Set<number>>();
    for (const r of dayRows || []) {
      dayCount[r.platform] = (dayCount[r.platform] || 0) + 1;
      const set = takenByPage.get(r.meta_page_id) || new Set<number>();
      set.add(localHourOf(r.scheduled_at as string, tz));
      takenByPage.set(r.meta_page_id, set);
    }

    // Active promo covering this date — themes the captions and may lift the cap.
    const { data: promos } = await admin
      .from("social_campaigns")
      .select("brief, boost_per_platform_per_day")
      .eq("workspace_id", workspaceId)
      .eq("active", true)
      .lte("starts_on", dateStr).gte("ends_on", dateStr)
      .order("starts_on", { ascending: false })
      .limit(1);
    const promo = promos?.[0] || null;
    const capForDay = promo?.boost_per_platform_per_day ? Math.max(dailyCap, promo.boost_per_platform_per_day) : dailyCap;

    // Cadence by weekday: story daily, feed Mon/Wed/Fri/Sun, reel Tue/Thu/Sat.
    const plan: { type: PostType; pages: typeof igPages }[] = [];
    if (config.cadence.story > 0) plan.push({ type: "story", pages: igPages });
    if (config.cadence.feed > 0 && [0, 1, 3, 5].includes(dow)) plan.push({ type: "feed", pages: [...igPages, ...fbPages] });
    if (config.cadence.reel > 0 && [2, 4, 6].includes(dow)) plan.push({ type: "reel", pages: igPages });

    for (const { type, pages: targets } of plan) {
      if (!targets.length) continue;
      // Idempotent: skip this (type, day) if already planned.
      const dayStart = `${dateStr}T00:00:00Z`, dayEnd = `${dateStr}T23:59:59Z`;
      const { data: existing } = await admin
        .from("scheduled_social_posts")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("post_type", type)
        .gte("scheduled_at", dayStart).lte("scheduled_at", dayEnd)
        .limit(1);
      if (existing?.length) continue;

      // Pick ONE asset + caption, cross-post to every target platform.
      const kind = kindForType(type, dayNum);
      const asset = await pickBySourceKind(admin, workspaceId, kind, reuseDays, date);
      if (!asset) continue;
      const caption = await generateCaption({
        workspaceId, sourceKind: kind, postType: type,
        productId: asset.productId, resourceSummary: asset.resourceSummary,
        now: date, campaignBrief: promo?.brief || undefined,
      });
      const candidateSlots = config.time_slots[type] || ["12:00"];
      const status = config.require_approval ? "draft" : "scheduled";

      for (const page of targets) {
        if ((dayCount[page.platform] || 0) >= capForDay) continue;  // per-platform daily cap (promo may lift it)
        // Optimizer picks the best open slot for this page/type (falls back to
        // the configured order before any insights data exists).
        const taken = takenByPage.get(page.id) || new Set<number>();
        const slot = pickBestSlot(signals, page.id, page.platform, type, candidateSlots, taken);
        const scheduledAt = zonedToUtc(dateStr, slot, tz).toISOString();
        const { data: row } = await admin.from("scheduled_social_posts").insert({
          workspace_id: workspaceId,
          meta_page_id: page.id,
          platform: page.platform,
          post_type: type,
          source_kind: kind,
          source_ref_id: asset.sourceRefId,
          product_id: asset.productId,
          media_bucket: asset.mediaBucket || null,
          media_path: asset.mediaPath || null,
          media_url: asset.mediaUrl || null,
          caption,
          scheduled_at: scheduledAt,
          status,
          created_by: "system",
        }).select("id").single();
        if (!row) continue;
        dayCount[page.platform] = (dayCount[page.platform] || 0) + 1;
        taken.add(Number(slot.split(":")[0])); takenByPage.set(page.id, taken);
        created++;
        if (status === "scheduled") {
          await inngest.send({ name: "social/publish", data: { post_id: row.id } });
        }
      }
    }
  }
  return created;
}

export const socialSchedulerPlan = inngest.createFunction(
  {
    id: "social-scheduler-plan",
    name: "Social — daily planner (rolling 7-day window)",
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 9 * * *" }, { event: "social/plan.tick" }],
  },
  async ({ step }) => {
    const workspaces = await step.run("load-enabled-workspaces", async () => {
      const admin = createAdminClient();
      const { data } = await admin.from("workspaces").select("id, social_scheduler_config");
      return (data || [])
        .map((w) => ({ id: w.id as string, config: (w.social_scheduler_config || {}) as SchedulerConfig }))
        .filter((w) => w.config?.enabled && w.config?.target_meta_page_ids?.length);
    });

    let total = 0;
    for (const ws of workspaces) {
      const n = await step.run(`plan-${ws.id}`, () => planWorkspace(ws.id, ws.config));
      total += n;
    }
    return { workspaces: workspaces.length, created: total };
  },
);

export const socialPublish = inngest.createFunction(
  {
    id: "social-publish",
    name: "Social — publish a scheduled post",
    concurrency: [{ limit: 3 }],
    retries: 2,
    triggers: [{ event: "social/publish" }],
  },
  async ({ event, step }) => {
    const postId = event.data?.post_id as string;
    if (!postId) return { error: "no post_id" };

    const initial = await step.run("load", async () => {
      const admin = createAdminClient();
      const { data } = await admin.from("scheduled_social_posts").select("scheduled_at, status").eq("id", postId).maybeSingle();
      return data;
    });
    if (!initial || (initial.status !== "scheduled")) return { skipped: initial?.status || "missing" };

    await step.sleepUntil("wait-for-slot", new Date(initial.scheduled_at as string));

    // Re-read: an operator may have edited the caption/media or cancelled it.
    const post = await step.run("reload", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("scheduled_social_posts")
        .select("id, workspace_id, meta_page_id, platform, post_type, caption, media_url, media_bucket, media_path, status")
        .eq("id", postId).maybeSingle();
      return data as (ScheduledPostRow & { status: string }) | null;
    });
    if (!post || post.status !== "scheduled") return { skipped: post?.status || "missing" };

    await step.run("mark-publishing", async () => {
      const admin = createAdminClient();
      await admin.from("scheduled_social_posts").update({ status: "publishing", updated_at: new Date().toISOString() }).eq("id", postId);
    });

    const result = await step.run("publish", () => publishScheduledPost(post));

    await step.run("finalize", async () => {
      const admin = createAdminClient();
      if (result.ok) {
        await admin.from("scheduled_social_posts").update({
          status: "posted", published_platform_id: result.platformId,
          published_permalink: result.permalink || null, published_at: new Date().toISOString(),
          error: null, updated_at: new Date().toISOString(),
        }).eq("id", postId);
      } else {
        await admin.from("scheduled_social_posts").update({
          status: "failed", error: result.error, updated_at: new Date().toISOString(),
        }).eq("id", postId);
      }
    });

    return result.ok ? { posted: result.platformId } : { failed: result.error };
  },
);
