/**
 * App Home tab for the Slack Roadmap Console — make the App Home a *destination*, not a launcher
 * ([[../specs/slack-home-detail]]). The roadmap board is mirrored onto the ShopCX app's persistent,
 * app-owned Block Kit surface (NOT a message): specs grouped Planned / In progress / Shipped, each a
 * compact one-line row with a status chip + a single **Details** affordance. Tapping Details opens an
 * in-Slack **modal** (buildSpecModal) carrying the spec's full detail — status, owner · parent, phases,
 * the "## Verification" how-to-test steps, summary — and the build/verify actions live IN the modal, so
 * you review and build a spec end-to-end without ever leaving Slack ("Open in ShopCX" is a footer link).
 *
 * The view is rebuilt from `getRoadmap()`/`getSpec()` ([[brain-roadmap]]) on every `app_home_opened`
 * (and after a queued build), so it never drifts from the brain. Pure rendering here (no token spend);
 * the actual build/verify is owner-gated + server-revalidated in roadmap-actions.ts via the interactions
 * endpoint, exactly like the board's BuildButton.
 *
 * See docs/brain/specs/slack-home-detail.md.
 */
import { getRoadmap, functionLabel, parentLabel, extractSpecSection, type SpecCard, type Phase, type SpecStatus } from "@/lib/brain-roadmap";
import { getLatestJobsBySlug, getPendingFolds, isActive, type AgentJob, type PendingFold } from "@/lib/agent-jobs";
import { jobChip } from "@/lib/slack-roadmap";
import { publishHomeView } from "@/lib/slack";
import { createAdminClient } from "@/lib/supabase/admin";

const WEB = "https://shopcx.ai";
const DASH = `${WEB}/dashboard/roadmap`;

// action_id prefixes (the slug — and phase number — are embedded so multiple per-row/modal buttons
// stay unique within an actions block). The interactions handler matches on these prefixes.
export const HOME = {
  build: "roadmap_build:", // roadmap_build:{slug}            → build all
  buildPhase: "roadmap_build_phase:", // roadmap_build_phase:{slug}:{n}  → build one phase
  verify: "roadmap_verify:", // roadmap_verify:{slug}           → mark verified & archive (fold-build)
  details: "roadmap_details:", // roadmap_details:{slug}          → open the spec-detail modal
  open: "roadmap_home_open:", // roadmap_home_open:{slug}        → URL button (no-op ack); legacy rows
} as const;

const PHASE_EMOJI: Record<SpecStatus, string> = { planned: "⏳", in_progress: "🚧", in_testing: "🧪", in_review: "🔍", shipped: "✅", deferred: "⏸️", rejected: "❌" };

// Block Kit ceilings: a view allows ≤100 blocks and an actions block ≤25 elements. Each spec is now a
// single section row (Details accessory), so we can show more per group before linking out.
const CAPS: Record<"in_progress" | "planned" | "shipped", number> = { in_progress: 20, planned: 20, shipped: 16 };
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

// ── App Home view (Phase 3 — compact, grouped, counts + box-health header) ──

/** A compact one-line build-box health line for the Home header, from the worker_heartbeats singleton. */
async function boxHealthLine(): Promise<string> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("worker_heartbeats")
      .select("running_sha, status, active_builds, last_poll_at")
      .eq("id", "box")
      .maybeSingle();
    if (!data) return "🔌 Build box: never reported.";
    const last = data.last_poll_at ? Date.parse(data.last_poll_at as string) : 0;
    const ageMs = last ? Date.now() - last : Infinity;
    // Health = recency, not just stored status: a dead worker can't flip its own row (≤90s ⇒ live).
    const live = ageMs < 90_000 && data.status !== "needs_attention";
    const sha = data.running_sha ? ` \`${data.running_sha}\`` : "";
    const builds = (data.active_builds as number | null) ?? 0;
    if (!live) {
      const ago = Number.isFinite(ageMs) ? ` (last poll ${Math.round(ageMs / 1000)}s ago)` : "";
      return `🔴 Build box down${ago} — builds queue until it's back.`;
    }
    return `🟢 Build box healthy${sha} · ${builds === 0 ? "idle" : `${builds} building`}`;
  } catch {
    return "";
  }
}

/** One compact spec row: a section with the status/title/chip line + a single Details button accessory. */
function specRow(spec: SpecCard, job: AgentJob | null | undefined, fold: PendingFold | null | undefined): unknown {
  const chip = jobChip(job, fold);
  const warn = job?.status === "needs_input" || job?.status === "needs_approval" ? " ⚠️" : "";
  const title = `${PHASE_EMOJI[spec.status]} *${truncate(spec.title, 150)}*${chip ? `   ${chip}` : ""}${warn}`;
  const meta = `\`${spec.slug}\`${ownerChip(spec)}`;
  return {
    type: "section",
    text: { type: "mrkdwn", text: `${title}\n${meta}` },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "Details", emoji: true },
      action_id: `${HOME.details}${spec.slug}`,
      value: JSON.stringify({ slug: spec.slug }),
    },
  };
}

/**
 * Build the App Home `home` view from the brain roadmap + live `agent_jobs`. Grouped by status with
 * counts + a box-health header; each spec is a compact Details row (the modal is where you act).
 * Capped per group with a "full board ↗" link so nothing is silently dropped. Read-only — no writes.
 */
export async function buildHomeView(workspaceId: string): Promise<Record<string, unknown>> {
  const [{ specs }, jobs, folds, health] = await Promise.all([
    getRoadmap(),
    getLatestJobsBySlug(workspaceId),
    getPendingFolds(workspaceId),
    boxHealthLine(),
  ]);

  const counts = { in_progress: 0, planned: 0, shipped: 0 };
  for (const s of specs) {
    if (s.status === "in_progress") counts.in_progress++;
    else if (s.status === "planned") counts.planned++;
    else if (s.status === "shipped") counts.shipped++;
  }
  const countLine = `In progress ${counts.in_progress} · Planned ${counts.planned} · Shipped ${counts.shipped}`;

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: "🗺️ ShopCX Roadmap", emoji: true } },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `${countLine}${health ? `   ·   ${health}` : ""}` }],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Tap *Details* on a spec to review + build it here — or open the <${DASH}|full board ↗>.` }],
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
      blocks.push(specRow(spec, jobs[spec.slug], folds[spec.slug]));
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

// ── In-Slack spec-detail modal (Phase 2 — the destination) ──

/** Build all + per-phase Build N + Mark verified & archive — the owner-gated actions that live in the modal. */
function modalActionElements(spec: SpecCard, job: AgentJob | null | undefined, fold: PendingFold | null | undefined): Record<string, unknown>[] {
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
  // Mark verified & archive mirrors the dashboard's gate: only a shipped spec with no active build /
  // fold in flight (queueRoadmapBuild({verify:true}) coalesces into a batch fold-build).
  const active = !!job && isActive(job.status);
  const merged = job?.status === "merged";
  const folding = !!fold && (fold.status === "pending" || fold.status === "folding");
  if (spec.status === "shipped" && !active && !merged && !folding) {
    out.push({
      type: "button",
      text: { type: "plain_text", text: "✅ Mark verified & archive", emoji: true },
      action_id: `${HOME.verify}${spec.slug}`,
      value: JSON.stringify({ slug: spec.slug }),
    });
  }
  return out;
}

/**
 * The in-Slack spec-detail modal — the primary surface (Phase 2). Renders status, owner · parent,
 * phases (✅/🚧/⏳), the "## Verification" how-to-test steps, and the summary, from getSpec()'s raw
 * markdown + parsed card. Build/verify actions live here (owner only); "Open in ShopCX" is a footer link.
 */
export function buildSpecModal(
  spec: SpecCard,
  raw: string,
  job: AgentJob | null | undefined,
  fold: PendingFold | null | undefined,
  owner: boolean,
): Record<string, unknown> {
  const chip = jobChip(job, fold);
  const ownerParent = [
    spec.owner ? `*Owner:* ${functionLabel(spec.owner)}` : "",
    spec.parent ? `*Parent:* ${parentLabel(spec.parent)}` : "",
  ].filter(Boolean).join("   ·   ");

  const phaseLines = spec.phases.length
    ? spec.phases.map((p, i) => `${PHASE_EMOJI[p.status]} *${i + 1}.* ${p.title}`).join("\n")
    : "_No phases parsed._";

  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `\`${spec.slug}\`   ·   ${PHASE_EMOJI[spec.status]} ${spec.status.replace("_", " ")}${chip ? `   ·   ${chip}` : ""}` } },
  ];
  if (ownerParent) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: ownerParent }] });
  if (spec.summary) blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(spec.summary, 2900) } });

  blocks.push({ type: "divider" });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Phases*\n${truncate(phaseLines, 2900)}` } });

  const verification = extractSpecSection(raw, "Verification");
  if (verification) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*✅ How to verify in prod*\n${truncate(verification, 2900)}` } });
  }

  if (owner) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "actions", elements: modalActionElements(spec, job, fold) });
  } else {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "_Building is reserved for the workspace owner._" }] });
  }
  // "Open in ShopCX" demotes to a small footer link — the modal is the primary surface, not the launcher.
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${DASH}/${spec.slug}|Open in ShopCX ↗>` }] });

  return {
    type: "modal",
    callback_id: "roadmap_spec_modal",
    private_metadata: JSON.stringify({ slug: spec.slug }),
    title: { type: "plain_text", text: truncate(spec.title, 24), emoji: true },
    close: { type: "plain_text", text: "Close", emoji: true },
    blocks,
  };
}

/** A small confirmation modal shown in place (views.update) after a build/verify action from the spec modal. */
export function buildSpecConfirmModal(title: string, text: string): Record<string, unknown> {
  return {
    type: "modal",
    title: { type: "plain_text", text: truncate(title, 24), emoji: true },
    close: { type: "plain_text", text: "Done", emoji: true },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: truncate(text, 2900) } }],
  };
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
