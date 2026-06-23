/**
 * Daily digest cron — ONE aggregated Slack post per day to #daily-digest.
 *
 * The Slack-cleanup pass (2026-06-23) stopped the per-event FYI flood: build/roadmap
 * transitions moved to the Agents hub, ops *warnings* stopped DMing everyone (only
 * CRITICAL pages #alerts-critical), and notable-but-non-urgent money/retention/platform
 * signals had nowhere to land. This cron rolls all of that FYI-grade noise into ONE
 * scannable post per day to #daily-digest (C0BCQ1ZNJ1F):
 *   - Build/ship recap   — the day's director_activity + agent_jobs (the directors' EOD standup, Slack-mirrored).
 *   - Money/retention     — dunning recoveries + still-failing; notable Meta ad-perf shifts (material deltas only).
 *   - Platform            — non-critical ops-warning count + items awaiting approval in the Agents hub.
 * with a link to the Agents hub for the detail.
 *
 * Gated on a Slack token (no-op if absent). A quiet day still posts a brief "quiet day"
 * digest (never an error). Critical ops alerts are UNAFFECTED — they still page
 * #alerts-critical in real time (notify-ops-alert.ts), never delayed into this digest.
 *
 * Registered in MONITORED_LOOPS (control-tower/registry.ts) so a dead digest is visible.
 * See docs/brain/specs/daily-digest-channel.md · docs/brain/inngest/daily-digest-cron.md.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSlackToken, postMessage } from "@/lib/slack";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

type Admin = ReturnType<typeof createAdminClient>;

const DAILY_DIGEST_CHANNEL = "C0BCQ1ZNJ1F"; // #daily-digest
const AGENTS_HUB_URL = "https://shopcx.ai/dashboard/agents";
const WINDOW_MS = 24 * 60 * 60 * 1000; // rolling 24h ("the day")

/** What the digest summarizes — every field degrades to a safe zero/empty on a query failure. */
interface DigestData {
  // Build/ship recap
  buildsCompleted: number; // agent_jobs kind='build' → completed (PR opened) in window
  buildsFailed: number;
  fixesAuthored: number; // director_activity authored_fix
  escalations: number; // director_activity escalated
  directorActions: number; // total director_activity rows in window
  // Money / retention
  dunningRecovered: number; // dunning_cycles recovered in window
  dunningRetrying: number; // dunning_cycles currently retrying (live backlog)
  dunningExhausted: number; // dunning_cycles exhausted in window
  adPerf: { spendToday: number; spendPrev: number; roasToday: number; roasPrev: number } | null; // dollars; null = not material/no data
  // Platform
  opsWarnings: number; // error_events touched in window (the warnings that no longer DM)
  awaitingApproval: number; // agent_jobs awaiting owner approval in the Agents hub
}

const EMPTY_DATA = (): DigestData => ({
  buildsCompleted: 0,
  buildsFailed: 0,
  fixesAuthored: 0,
  escalations: 0,
  directorActions: 0,
  dunningRecovered: 0,
  dunningRetrying: 0,
  dunningExhausted: 0,
  adPerf: null,
  opsWarnings: 0,
  awaitingApproval: 0,
});

/** A material ad-perf shift = a big relative AND absolute spend swing, or a meaningful ROAS swing. */
function isMaterialAdShift(spendToday: number, spendPrev: number, roasToday: number, roasPrev: number): boolean {
  if (spendPrev <= 0) return spendToday >= 50; // first material spend day
  const spendDeltaPct = Math.abs(spendToday - spendPrev) / spendPrev;
  const bigSpend = spendDeltaPct >= 0.25 && Math.abs(spendToday - spendPrev) >= 50;
  const bigRoas = Math.abs(roasToday - roasPrev) >= 0.5;
  return bigSpend || bigRoas;
}

/** Aggregate one workspace's last-24h digest. Every read is best-effort — a failure leaves that field at its zero. */
async function aggregateDigest(admin: Admin, workspaceId: string, since: string): Promise<DigestData> {
  const data = EMPTY_DATA();

  // ── Build/ship recap — agent_jobs (window on updated_at) + director_activity (window on created_at) ──
  try {
    const { data: jobs } = await admin
      .from("agent_jobs")
      .select("kind, status")
      .eq("workspace_id", workspaceId)
      .eq("kind", "build")
      .gte("updated_at", since)
      .limit(1000);
    for (const j of jobs || []) {
      if (j.status === "completed") data.buildsCompleted++;
      else if (j.status === "failed" || j.status === "needs_attention") data.buildsFailed++;
    }
  } catch (e) {
    console.warn("[daily-digest] agent_jobs read failed:", e instanceof Error ? e.message : e);
  }

  try {
    const { data: acts } = await admin
      .from("director_activity")
      .select("action_kind")
      .eq("workspace_id", workspaceId)
      .gte("created_at", since)
      .limit(2000);
    for (const a of acts || []) {
      data.directorActions++;
      if (a.action_kind === "authored_fix" || a.action_kind === "fixed_bug") data.fixesAuthored++;
      else if (a.action_kind === "escalated") data.escalations++;
    }
  } catch (e) {
    console.warn("[daily-digest] director_activity read failed:", e instanceof Error ? e.message : e);
  }

  // ── Dunning — recovered in window + currently retrying + exhausted in window ──
  try {
    const { count } = await admin
      .from("dunning_cycles")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "recovered")
      .gte("recovered_at", since);
    data.dunningRecovered = count || 0;
  } catch (e) {
    console.warn("[daily-digest] dunning recovered read failed:", e instanceof Error ? e.message : e);
  }
  try {
    const { count } = await admin
      .from("dunning_cycles")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "retrying");
    data.dunningRetrying = count || 0;
  } catch (e) {
    console.warn("[daily-digest] dunning retrying read failed:", e instanceof Error ? e.message : e);
  }
  try {
    const { count } = await admin
      .from("dunning_cycles")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "exhausted")
      .gte("updated_at", since);
    data.dunningExhausted = count || 0;
  } catch (e) {
    console.warn("[daily-digest] dunning exhausted read failed:", e instanceof Error ? e.message : e);
  }

  // ── Ad-perf — latest two snapshot days of daily_meta_ad_spend; surface only a material shift ──
  try {
    const { data: spend } = await admin
      .from("daily_meta_ad_spend")
      .select("snapshot_date, spend_cents, purchase_value_cents")
      .eq("workspace_id", workspaceId)
      .order("snapshot_date", { ascending: false })
      .limit(60);
    // Roll up per day across accounts.
    const byDay = new Map<string, { spend: number; rev: number }>();
    for (const r of spend || []) {
      const d = String(r.snapshot_date);
      const cur = byDay.get(d) || { spend: 0, rev: 0 };
      cur.spend += Number(r.spend_cents || 0);
      cur.rev += Number(r.purchase_value_cents || 0);
      byDay.set(d, cur);
    }
    const days = Array.from(byDay.keys()).sort().reverse(); // newest first
    if (days.length >= 2) {
      const t = byDay.get(days[0])!;
      const p = byDay.get(days[1])!;
      const spendToday = t.spend / 100;
      const spendPrev = p.spend / 100;
      const roasToday = t.spend > 0 ? t.rev / t.spend : 0;
      const roasPrev = p.spend > 0 ? p.rev / p.spend : 0;
      if (isMaterialAdShift(spendToday, spendPrev, roasToday, roasPrev)) {
        data.adPerf = { spendToday, spendPrev, roasToday, roasPrev };
      }
    }
  } catch (e) {
    console.warn("[daily-digest] ad-perf read failed:", e instanceof Error ? e.message : e);
  }

  // ── Platform — non-critical ops warnings (error feed touched in window) + items awaiting approval ──
  try {
    const { count } = await admin
      .from("error_events")
      .select("id", { count: "exact", head: true })
      .gte("last_seen_at", since);
    data.opsWarnings = count || 0;
  } catch (e) {
    console.warn("[daily-digest] error_events read failed:", e instanceof Error ? e.message : e);
  }
  try {
    const { count } = await admin
      .from("agent_jobs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "needs_approval");
    data.awaitingApproval = count || 0;
  } catch (e) {
    console.warn("[daily-digest] awaiting-approval read failed:", e instanceof Error ? e.message : e);
  }

  return data;
}

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** Build the single Slack message. Returns null when there is literally nothing to say beyond "quiet day". */
function buildDigestBlocks(data: DigestData, dateLabel: string): { blocks: unknown[]; text: string } {
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `📊 Daily digest — ${dateLabel}`, emoji: true } },
  ];

  // Build/ship recap
  const buildBits: string[] = [];
  if (data.buildsCompleted) buildBits.push(`${data.buildsCompleted} build${data.buildsCompleted === 1 ? "" : "s"} shipped`);
  if (data.fixesAuthored) buildBits.push(`${data.fixesAuthored} fix${data.fixesAuthored === 1 ? "" : "es"}`);
  if (data.escalations) buildBits.push(`${data.escalations} escalation${data.escalations === 1 ? "" : "s"}`);
  if (data.buildsFailed) buildBits.push(`${data.buildsFailed} failed`);
  if (data.directorActions) buildBits.push(`${data.directorActions} director action${data.directorActions === 1 ? "" : "s"}`);
  if (buildBits.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*🛠 Build & ship (24h)*\n${buildBits.join(" · ")}` } });
  }

  // Money / retention
  const moneyBits: string[] = [];
  if (data.dunningRecovered || data.dunningRetrying || data.dunningExhausted) {
    const d: string[] = [];
    if (data.dunningRecovered) d.push(`${data.dunningRecovered} recovered`);
    if (data.dunningRetrying) d.push(`${data.dunningRetrying} still retrying`);
    if (data.dunningExhausted) d.push(`${data.dunningExhausted} exhausted`);
    moneyBits.push(`Dunning: ${d.join(" · ")}`);
  }
  if (data.adPerf) {
    const dir = data.adPerf.spendToday >= data.adPerf.spendPrev ? "↑" : "↓";
    moneyBits.push(
      `Ad spend ${dir} ${money(data.adPerf.spendPrev)}→${money(data.adPerf.spendToday)}, ROAS ${data.adPerf.roasPrev.toFixed(2)}→${data.adPerf.roasToday.toFixed(2)}`,
    );
  }
  if (moneyBits.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*💸 Money & retention*\n${moneyBits.join("\n")}` } });
  }

  // Platform
  const platBits: string[] = [];
  if (data.opsWarnings) platBits.push(`${data.opsWarnings} ops warning${data.opsWarnings === 1 ? "" : "s"} (non-critical)`);
  if (data.awaitingApproval) platBits.push(`${data.awaitingApproval} item${data.awaitingApproval === 1 ? "" : "s"} awaiting approval`);
  if (platBits.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*🩺 Platform*\n${platBits.join(" · ")}` } });
  }

  const hadContent = blocks.length > 1;
  if (!hadContent) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "Quiet day — nothing notable to report. 🌙" } });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `<${AGENTS_HUB_URL}|Open the Agents hub →> for the detail.` }],
  });

  const text = `Daily digest — ${dateLabel}`;
  return { blocks, text };
}

export const dailyDigestCron = inngest.createFunction(
  { id: "daily-digest-cron", retries: 1, triggers: [{ cron: "0 13 * * *" }] },
  async ({ step }) => {
    const admin = createAdminClient();
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const dateLabel = new Date().toISOString().slice(0, 10);

    const result = await step.run("post-digests", async () => {
      // Slack-connected workspaces only (gated on a token).
      const { data: workspaces } = await admin
        .from("workspaces")
        .select("id")
        .not("slack_bot_token_encrypted", "is", null);

      let posted = 0;
      let skipped = 0;
      for (const ws of workspaces || []) {
        try {
          const token = await getSlackToken(ws.id);
          if (!token) {
            skipped++;
            continue; // no usable token → no-op for this workspace
          }
          const data = await aggregateDigest(admin, ws.id, since);
          const { blocks, text } = buildDigestBlocks(data, dateLabel);
          const ok = await postMessage(token, DAILY_DIGEST_CHANNEL, blocks, text);
          if (ok) posted++;
          else skipped++;
        } catch (e) {
          console.warn("[daily-digest] workspace failed:", e instanceof Error ? e.message : e);
          skipped++;
        }
      }
      return { workspaces: (workspaces || []).length, posted, skipped, since, dateLabel };
    });

    // Control Tower: end-of-run heartbeat (loop_id = the inngest function id).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("daily-digest-cron", { ok: true, produced: result });
    });

    return result;
  },
);
