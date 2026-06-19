/**
 * App Home tab for the Slack Roadmap Console — mirror the roadmap board onto the ShopCX app's
 * persistent, app-owned Block Kit surface (NOT a message). Specs grouped Planned / In progress /
 * Shipped, each row carrying a live build-status chip + **Build all** / per-phase **Build N** /
 * **Open** buttons. The view is rebuilt from `getRoadmap()` ([[brain-roadmap]]) on every
 * `app_home_opened` (and after a queued build), so it never drifts from the brain.
 *
 * Pure rendering here (no token spend); the actual build is owner-gated + server-revalidated in
 * roadmap-actions.ts via the interactions endpoint, exactly like the board's BuildButton.
 *
 * See docs/brain/specs/slack-roadmap-home.md (Phases 1–2).
 */
import { getRoadmap, functionLabel, type SpecCard, type Phase } from "@/lib/brain-roadmap";
import { getLatestJobsBySlug, getPendingFolds, type AgentJob, type PendingFold } from "@/lib/agent-jobs";
import { jobChip } from "@/lib/slack-roadmap";
import { publishHomeView } from "@/lib/slack";

const WEB = "https://shopcx.ai";
const DASH = `${WEB}/dashboard/roadmap`;

// action_id prefixes (the slug — and phase number — are embedded so multiple per-row buttons
// stay unique within an actions block). The interactions handler matches on these prefixes.
export const HOME = {
  build: "roadmap_build:", // roadmap_build:{slug}            → build all
  buildPhase: "roadmap_build_phase:", // roadmap_build_phase:{slug}:{n}  → build one phase
  open: "roadmap_home_open:", // roadmap_home_open:{slug}        → URL button (no-op ack)
} as const;

const PHASE_EMOJI: Record<Phase, string> = { planned: "⏳", in_progress: "🚧", shipped: "✅", rejected: "❌" };

// Block Kit ceilings: a view allows ≤100 blocks and an actions block ≤25 elements. Cap rows per
// group (link out for the rest) and per-phase buttons so we never silently truncate or overflow.
const CAPS: Record<"in_progress" | "planned" | "shipped", number> = { in_progress: 12, planned: 12, shipped: 8 };
const PHASE_BTN_CAP = 4;

const GROUPS: { status: Phase; label: string }[] = [
  { status: "in_progress", label: "🚧 In progress" },
  { status: "planned", label: "⏳ Planned" },
  { status: "shipped", label: "✅ Shipped — awaiting verification" },
];

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function ownerChip(spec: SpecCard): string {
  return spec.owner ? `   ·   _${functionLabel(spec.owner)}_` : "";
}

/** Build all + per-phase Build N + Open — the owner-gated row actions (mirrors the board's BuildButton). */
function rowButtons(spec: SpecCard): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "🛠️ Build all", emoji: true },
      style: "primary",
      action_id: `${HOME.build}${spec.slug}`,
      value: JSON.stringify({ slug: spec.slug }),
    },
  ];
  // Per-phase buttons only when there's more than one phase to disambiguate; cap to stay ≤25 elements.
  if (spec.phases.length > 1) {
    spec.phases.slice(0, PHASE_BTN_CAP).forEach((ph, i) => {
      const n = i + 1;
      out.push({
        type: "button",
        text: { type: "plain_text", text: `Build ${n}`, emoji: true },
        action_id: `${HOME.buildPhase}${spec.slug}:${n}`,
        value: JSON.stringify({ slug: spec.slug, n, phaseTitle: ph.title }),
      });
    });
  }
  out.push({
    type: "button",
    text: { type: "plain_text", text: "Open ↗", emoji: true },
    url: `${DASH}/${spec.slug}`,
    action_id: `${HOME.open}${spec.slug}`,
  });
  return out;
}

/** A non-shipped spec → a status section + its action buttons. */
function specRow(spec: SpecCard, job: AgentJob | null | undefined, fold: PendingFold | null | undefined): unknown[] {
  const chip = jobChip(job, fold);
  const warn = job?.status === "needs_input" || job?.status === "needs_approval" ? " ⚠️" : "";
  const title = `${PHASE_EMOJI[spec.status]} *${truncate(spec.title, 150)}*${chip ? `   ${chip}` : ""}${warn}`;
  const meta = `\`${spec.slug}\`${ownerChip(spec)}`;
  return [
    { type: "section", text: { type: "mrkdwn", text: `${title}\n${meta}` } },
    { type: "actions", elements: rowButtons(spec) },
  ];
}

/** A shipped spec → a single collapsed line (no build buttons; verify/rebuild lives on the board). */
function shippedRow(spec: SpecCard, job: AgentJob | null | undefined, fold: PendingFold | null | undefined): unknown {
  const chip = jobChip(job, fold);
  const text = `✅ *${truncate(spec.title, 150)}*${chip ? `   ${chip}` : ""}${ownerChip(spec)}   <${DASH}/${spec.slug}|open ↗>`;
  return { type: "section", text: { type: "mrkdwn", text } };
}

/**
 * Build the App Home `home` view from the brain roadmap + live `agent_jobs`. Grouped by status,
 * capped per group with a "full board ↗" link so nothing is silently dropped. Read-only — no writes.
 */
export async function buildHomeView(workspaceId: string): Promise<Record<string, unknown>> {
  const [{ specs }, jobs, folds] = await Promise.all([
    getRoadmap(),
    getLatestJobsBySlug(workspaceId),
    getPendingFolds(workspaceId),
  ]);

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: "🗺️ ShopCX Roadmap", emoji: true } },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Open a spec to build it — or see the <${DASH}|full board ↗>.` }],
    },
  ];

  let total = 0;
  for (const group of GROUPS) {
    const inGroup = specs.filter((s) => s.status === group.status);
    if (!inGroup.length) continue;
    const cap = CAPS[group.status as "in_progress" | "planned" | "shipped"];
    const shown = inGroup.slice(0, cap);
    const hidden = inGroup.length - shown.length;

    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${group.label}*  ·  ${inGroup.length}` } });

    for (const spec of shown) {
      const job = jobs[spec.slug];
      const fold = folds[spec.slug];
      if (group.status === "shipped") {
        blocks.push(shippedRow(spec, job, fold));
      } else {
        blocks.push(...specRow(spec, job, fold));
      }
      total += 1;
    }
    if (hidden > 0) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `_+${hidden} more in this group — see the <${DASH}|full board ↗>._` }],
      });
    }
  }

  if (total === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `_No in-flight specs. Author one in the <${DASH}|dashboard>._` } });
  }

  return { type: "home", blocks };
}

/** Publish a Home view for one Slack user (views.publish). Thin wrapper over the slack.ts API client. */
export async function publishHome(token: string, slackUserId: string, view: unknown): Promise<boolean> {
  return publishHomeView(token, slackUserId, view);
}

/** A small modal for transient Home-tab feedback — Home interactions carry no channel for an ephemeral. */
export function noticeModal(title: string, text: string): Record<string, unknown> {
  return {
    type: "modal",
    title: { type: "plain_text", text: truncate(title, 24), emoji: true },
    close: { type: "plain_text", text: "Close", emoji: true },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: truncate(text, 2900) } }],
  };
}
