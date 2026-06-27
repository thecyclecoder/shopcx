/**
 * Block Kit builders for the Slack Roadmap Console — pure rendering, no token spend.
 *
 * Turns the brain roadmap (`getRoadmap`) + live `agent_jobs` (`getLatestJobsBySlug`) +
 * pending folds (`getPendingFolds`) into a `#roadmap` board message, single-spec detail,
 * per-job notification messages (needs_input / needs_approval / completed / failed), and the
 * answer modal. Every interactive element encodes its target in a JSON `value` / `private_metadata`
 * blob; the actual mutation is owner-gated + server-revalidated in roadmap-actions.ts.
 *
 * See docs/brain/specs/slack-roadmap-console-run-the-build-console-from-slack.md (Phases 3–5).
 */
import type { AgentJob, JobQuestion, PendingAction, PendingFold } from "@/lib/agent-jobs";
import type { SpecCard, Phase, SpecStatus } from "@/lib/brain-roadmap";

// Interaction action_ids (also the callback_id for the answer modal).
export const ACTIONS = {
  build: "roadmap_build",
  viewPr: "roadmap_view_pr",
  merge: "roadmap_merge",
  answerOpen: "roadmap_answer_open",
  approve: "roadmap_approve",
  decline: "roadmap_decline",
  answerSubmit: "roadmap_answer_submit",
} as const;

const DASH = "https://shopcx.ai/dashboard/roadmap";
const BOARD_CARD_CAP = 16; // keep the board well under Slack's 50-block message ceiling

const PHASE_EMOJI: Record<SpecStatus, string> = { planned: "⏳", in_progress: "🚧", in_testing: "🧪", in_review: "🔍", shipped: "✅", deferred: "⏸️", rejected: "❌" };

const SECTIONS: { status: Phase; label: string }[] = [
  { status: "in_progress", label: "🚧 In progress" },
  { status: "planned", label: "⏳ Planned" },
  { status: "shipped", label: "✅ Shipped — awaiting verification" },
];

/** A short live chip for a spec's latest build job (+ pending-fold override). Empty string = idle. */
export function jobChip(job: AgentJob | null | undefined, fold: PendingFold | null | undefined): string {
  if (fold && (fold.status === "pending" || fold.status === "folding")) return "🗂️ Folding…";
  if (!job) return "";
  switch (job.status) {
    case "queued": return "⏳ queued";
    case "claimed":
    case "building": return "🛠️ building";
    case "needs_input": return "⚠️ needs input";
    case "needs_approval": return "⚠️ needs approval";
    case "queued_resume": return "🔄 resuming";
    case "completed": return "✅ built — PR open";
    case "merged": return "🎉 merged";
    case "failed": return "❌ failed";
    case "needs_attention": return "🚨 needs attention";
    default: return "";
  }
}

function jsonValue(v: Record<string, unknown>): string {
  return JSON.stringify(v);
}

function btn(text: string, actionId: string, value: string, style?: "primary" | "danger"): Record<string, unknown> {
  const b: Record<string, unknown> = { type: "button", text: { type: "plain_text", text, emoji: true }, action_id: actionId, value };
  if (style) b.style = style;
  return b;
}

function urlBtn(text: string, url: string, actionId: string): Record<string, unknown> {
  return { type: "button", text: { type: "plain_text", text, emoji: true }, url, action_id: actionId };
}

/** The action buttons appropriate to a card's current state (board + detail share this). */
function cardButtons(spec: SpecCard, job: AgentJob | null | undefined): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  // Build is always available (queueRoadmapBuild refuses + surfaces if one is already active).
  out.push(btn("🛠️ Build", ACTIONS.build, jsonValue({ slug: spec.slug })));
  if (job?.pr_url) out.push(urlBtn("🔗 View PR", job.pr_url, ACTIONS.viewPr));
  if (job?.status === "needs_input") out.push(btn("✍️ Answer", ACTIONS.answerOpen, jsonValue({ jobId: job.id })));
  if (job?.status === "completed" && job.pr_number) {
    out.push(btn("✅ Squash & merge", ACTIONS.merge, jsonValue({ prNumber: job.pr_number, slug: spec.slug }), "primary"));
  }
  return out;
}

// ── /roadmap board ──

export function buildBoardBlocks(input: {
  specs: SpecCard[];
  jobs: Record<string, AgentJob>;
  folds: Record<string, PendingFold>;
}): { blocks: unknown[]; text: string } {
  const { specs, jobs, folds } = input;
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: "🗺️ Roadmap", emoji: true } },
  ];

  let rendered = 0;
  let truncated = 0;
  for (const section of SECTIONS) {
    const inSection = specs.filter((s) => s.status === section.status);
    if (!inSection.length) continue;
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${section.label}*  ·  ${inSection.length}` } });
    for (const spec of inSection) {
      if (rendered >= BOARD_CARD_CAP) { truncated += 1; continue; }
      const job = jobs[spec.slug];
      const fold = folds[spec.slug];
      const chip = jobChip(job, fold);
      const warn = job?.status === "needs_input" || job?.status === "needs_approval" ? " ⚠️" : "";
      const line = `${PHASE_EMOJI[spec.status]} *${spec.title}*${chip ? `   ${chip}` : ""}${warn}\n\`${spec.slug}\``;
      blocks.push({ type: "section", text: { type: "mrkdwn", text: line } });
      const buttons = cardButtons(spec, job);
      if (buttons.length) blocks.push({ type: "actions", elements: buttons });
      rendered += 1;
    }
  }

  if (truncated > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `_+${truncated} more — open one with \`/roadmap <slug>\` or the <${DASH}|dashboard>._` }],
    });
  }
  if (rendered === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No in-flight specs. Author one in the <" + DASH + "|dashboard>._" } });
  }

  return { blocks, text: "🗺️ Roadmap board" };
}

// ── /roadmap <slug> detail ──

export function buildSpecDetailBlocks(spec: SpecCard, job: AgentJob | null, fold: PendingFold | null): { blocks: unknown[]; text: string } {
  const chip = jobChip(job, fold);
  const phaseLines = spec.phases.length
    ? spec.phases.map((p) => `${PHASE_EMOJI[p.status]} ${p.title}`).join("\n")
    : "_No phases parsed._";
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `${PHASE_EMOJI[spec.status]} ${truncate(spec.title, 140)}`, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `\`${spec.slug}\`${chip ? `   ·   ${chip}` : ""}` } },
  ];
  if (spec.summary) blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(spec.summary, 2900) } });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Phases*\n${truncate(phaseLines, 2900)}` } });
  const buttons = cardButtons(spec, job);
  if (job?.status === "needs_approval") buttons.unshift(urlBtn("⚠️ Review approval", DASH, ACTIONS.viewPr));
  if (buttons.length) blocks.push({ type: "actions", elements: buttons });
  return { blocks, text: `Roadmap: ${spec.title}` };
}

// ── Per-job push / update messages (Phase 4 update + Phase 5 watcher) ──

function jobHeader(spec: SpecCard | null, slug: string): string {
  return spec ? spec.title : slug;
}

export function buildNeedsInputMessage(slug: string, spec: SpecCard | null, job: AgentJob): { blocks: unknown[]; text: string } {
  const qs = (job.questions || []) as JobQuestion[];
  const qText = qs.length ? qs.map((q, i) => `*${i + 1}.* ${q.q}`).join("\n") : "_(no questions captured)_";
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: "⚠️ Build needs input", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*${jobHeader(spec, slug)}*\n\`${slug}\`` } },
    { type: "section", text: { type: "mrkdwn", text: truncate(qText, 2900) } },
    { type: "actions", elements: [btn("✍️ Answer", ACTIONS.answerOpen, jsonValue({ jobId: job.id }), "primary")] },
  ];
  return { blocks, text: `Build needs input: ${slug}` };
}

export function buildNeedsApprovalMessage(slug: string, spec: SpecCard | null, job: AgentJob): { blocks: unknown[]; text: string } {
  const actions = (job.pending_actions || []) as PendingAction[];
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: "⚠️ Build needs approval", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*${jobHeader(spec, slug)}*\n\`${slug}\`` } },
  ];
  for (const a of actions) {
    const preview = a.cmd || a.preview || "";
    const body = `*${a.type}* — ${a.summary}${preview ? `\n\`\`\`${truncate(preview, 2600)}\`\`\`` : ""}`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(body, 2900) } });
    if (a.status === "pending") {
      blocks.push({
        type: "actions",
        elements: [
          btn("✅ Approve & apply", ACTIONS.approve, jsonValue({ jobId: job.id, actionId: a.id, decision: "approve" }), "primary"),
          btn("✋ Decline", ACTIONS.decline, jsonValue({ jobId: job.id, actionId: a.id, decision: "decline" }), "danger"),
        ],
      });
    } else {
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `_${a.status}_` }] });
    }
  }
  return { blocks, text: `Build needs approval: ${slug}` };
}

export function buildCompletedMessage(slug: string, spec: SpecCard | null, job: AgentJob): { blocks: unknown[]; text: string } {
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: "✅ Build complete", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*${jobHeader(spec, slug)}*\n\`${slug}\`${job.pr_url ? `\n<${job.pr_url}|View PR #${job.pr_number ?? ""}>` : ""}` } },
  ];
  const elements: Record<string, unknown>[] = [];
  if (job.pr_url) elements.push(urlBtn("🔗 View PR", job.pr_url, ACTIONS.viewPr));
  // `m: 1` marks a single-purpose (non-board) message the merge handler may update in place.
  if (job.pr_number) elements.push(btn("✅ Squash & merge", ACTIONS.merge, jsonValue({ prNumber: job.pr_number, slug, m: 1 }), "primary"));
  if (elements.length) blocks.push({ type: "actions", elements });
  return { blocks, text: `Build complete: ${slug}` };
}

export function buildFailedMessage(slug: string, spec: SpecCard | null, job: AgentJob): { blocks: unknown[]; text: string } {
  const head = job.status === "needs_attention" ? "🚨 Build needs attention" : "❌ Build failed";
  const detail = [job.error ? `*Error:* ${job.error}` : "", job.log_tail ? `\`\`\`${truncate(job.log_tail, 2400)}\`\`\`` : ""]
    .filter(Boolean).join("\n");
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: head, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*${jobHeader(spec, slug)}*\n\`${slug}\`` } },
  ];
  if (detail) blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(detail, 2900) } });
  blocks.push({ type: "actions", elements: [urlBtn("Open dashboard", DASH, ACTIONS.viewPr), btn("🔁 Re-build", ACTIONS.build, jsonValue({ slug }))] });
  return { blocks, text: `Build ${job.status}: ${slug}` };
}

/** Pick the right push message for a transition the watcher is announcing. */
export function buildStatusPushMessage(slug: string, spec: SpecCard | null, job: AgentJob): { blocks: unknown[]; text: string } | null {
  switch (job.status) {
    case "needs_input": return buildNeedsInputMessage(slug, spec, job);
    case "needs_approval": return buildNeedsApprovalMessage(slug, spec, job);
    case "completed": return buildCompletedMessage(slug, spec, job);
    case "failed":
    case "needs_attention": return buildFailedMessage(slug, spec, job);
    default: return null;
  }
}

// ── Answer modal ──

/** A Block Kit modal rendering a job's open questions as inputs; submit → view_submission. */
export function buildAnswerModal(job: AgentJob, slug: string, origin?: { channel?: string; ts?: string }): Record<string, unknown> {
  const qs = (job.questions || []) as JobQuestion[];
  const inputs = qs.map((q) => {
    const hasOptions = Array.isArray(q.options) && q.options.length > 0;
    const element = hasOptions
      ? {
          type: "static_select",
          action_id: "answer",
          placeholder: { type: "plain_text", text: "Choose…", emoji: true },
          options: q.options!.slice(0, 100).map((o) => ({ text: { type: "plain_text", text: truncate(o, 74), emoji: true }, value: truncate(o, 150) })),
        }
      : { type: "plain_text_input", action_id: "answer", multiline: true };
    return {
      type: "input",
      block_id: q.id,
      label: { type: "plain_text", text: truncate(q.q, 140), emoji: true },
      element,
    };
  });
  if (!inputs.length) {
    inputs.push({
      type: "input",
      block_id: "no_questions",
      label: { type: "plain_text", text: "Note", emoji: true },
      element: { type: "plain_text_input", action_id: "answer", multiline: true },
    } as never);
  }
  return {
    type: "modal",
    callback_id: ACTIONS.answerSubmit,
    private_metadata: JSON.stringify({ jobId: job.id, slug, channel: origin?.channel, ts: origin?.ts }),
    title: { type: "plain_text", text: "Answer build", emoji: true },
    submit: { type: "plain_text", text: "Resume build", emoji: true },
    close: { type: "plain_text", text: "Cancel", emoji: true },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `Answering *${truncate(slug, 200)}* — submitting resumes the build.` } },
      ...inputs,
    ],
  };
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
