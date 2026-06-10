/**
 * Timing + frequency optimizer for the social scheduler.
 * See docs/brain/specs/automated-social-scheduler.md § Timing + frequency.
 *
 * Picks the best time slot for a post by blending two signals:
 *   audience-online heatmap (Meta Insights)  ×  our own historical engagement
 *   at that hour, for that platform + post type.
 * Before any data exists everything scores ~neutral, so it cleanly falls back
 * to the best-practice slot order from config.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface SlotSignals {
  audienceByPage: Map<string, number[]>;        // meta_page_id → [24] normalized 0..1
  history: Map<string, { sum: number; n: number }>; // `${platform}:${postType}:${hour}` → engagement
  historyMax: number;
}

function localHour(iso: string, tz: string): number {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date(iso)));
  return h === 24 ? 0 : h;
}

export async function loadSlotSignals(admin: Admin, workspaceId: string, tz: string): Promise<SlotSignals> {
  const [aud, posts] = await Promise.all([
    admin.from("social_audience_hours").select("meta_page_id, hour, score").eq("workspace_id", workspaceId),
    admin.from("scheduled_social_posts")
      .select("platform, post_type, scheduled_at, engagement")
      .eq("workspace_id", workspaceId).eq("status", "posted")
      .not("engagement", "is", null)
      .gte("scheduled_at", new Date(Date.now() - 60 * 86_400_000).toISOString()),
  ]);

  const audienceByPage = new Map<string, number[]>();
  for (const r of aud.data || []) {
    if (!audienceByPage.has(r.meta_page_id)) audienceByPage.set(r.meta_page_id, Array(24).fill(0.5));
    audienceByPage.get(r.meta_page_id)![r.hour] = Number(r.score);
  }

  const history = new Map<string, { sum: number; n: number }>();
  let historyMax = 1;
  for (const p of posts.data || []) {
    const hr = localHour(p.scheduled_at, tz);
    const key = `${p.platform}:${p.post_type}:${hr}`;
    const cur = history.get(key) || { sum: 0, n: 0 };
    cur.sum += p.engagement || 0; cur.n += 1;
    history.set(key, cur);
    historyMax = Math.max(historyMax, cur.sum / cur.n);
  }
  return { audienceByPage, history, historyMax };
}

/**
 * Best slot for (page, platform, type) among candidate "HH:mm" slots, skipping
 * hours already taken that day. score = (0.5 + audience) × (1 + histNorm).
 */
export function pickBestSlot(
  signals: SlotSignals, metaPageId: string, platform: string, postType: string,
  candidateSlots: string[], takenHours: Set<number>,
): string {
  if (!candidateSlots.length) return "12:00";
  const audience = signals.audienceByPage.get(metaPageId);
  let best = candidateSlots[0], bestScore = -1;
  for (const slot of candidateSlots) {
    const hour = Number(slot.split(":")[0]);
    if (takenHours.has(hour)) continue;
    const aud = audience ? audience[hour] ?? 0.5 : 0.5;
    const h = signals.history.get(`${platform}:${postType}:${hour}`);
    const hist = h && h.n ? (h.sum / h.n) / signals.historyMax : 0;
    const score = (0.5 + aud) * (1 + hist);
    if (score > bestScore) { bestScore = score; best = slot; }
  }
  return best;
}

/**
 * Frequency hint: is per-post reach trending up enough to post more, or down
 * (fatigue) so we should ease off? Surfaced to the operator — not auto-applied.
 */
export async function frequencyHint(admin: Admin, workspaceId: string): Promise<"increase" | "hold" | "decrease" | "no_data"> {
  const { data } = await admin.from("scheduled_social_posts")
    .select("scheduled_at, reach")
    .eq("workspace_id", workspaceId).eq("status", "posted")
    .not("reach", "is", null)
    .gte("scheduled_at", new Date(Date.now() - 28 * 86_400_000).toISOString())
    .order("scheduled_at", { ascending: true });
  const rows = data || [];
  if (rows.length < 8) return "no_data";
  const mid = Math.floor(rows.length / 2);
  const avg = (a: typeof rows) => a.reduce((s, r) => s + (r.reach || 0), 0) / (a.length || 1);
  const prev = avg(rows.slice(0, mid)), recent = avg(rows.slice(mid));
  if (recent > prev * 1.1) return "increase";
  if (recent < prev * 0.85) return "decrease";
  return "hold";
}
