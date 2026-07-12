"use client";

/**
 * Shared render helpers for the god-mode surfaces — the in-app GodModeTab and the
 * SMS cockpit /god/[token] page (docs/brain/lifecycles/god-mode.md). Both render the
 * same CEO-grade UX: a live checklist widget, plain-language decision cards, and a
 * consistent badge palette. Kept here (not in either page dir) so both import one
 * source of truth.
 */

/**
 * Eve's headshot — the executive-assistant persona's avatar (mirrors
 * PERSONAS["god-mode"].avatarUrl in src/lib/agents/personas.ts). Shown next to
 * her chat bubbles so a text conversation with Eve feels like texting a person,
 * not a console. Kept as a literal here (not imported from personas.ts) so these
 * client surfaces don't pull the whole persona map into the bundle.
 */
export const EVE_AVATAR_URL =
  "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/agent-avatars/eve-god-mode.jpg?v=1";

/** Eve's round profile picture. `size` is the pixel diameter. */
export function EveAvatar({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={EVE_AVATAR_URL}
      alt="Eve"
      width={size}
      height={size}
      className={`shrink-0 rounded-full object-cover ring-1 ring-amber-200 dark:ring-amber-900/50 ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

type ChecklistStepState = "pending" | "active" | "done";
type ChecklistPayload = { title: string; steps: { label: string; state: ChecklistStepState }[] };

/** Risk badge palette. 'decision' (a plain CEO ask) reads calm indigo; the destructive floor is red. */
export const DEC_RISK_BADGE: Record<string, string> = {
  decision: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  destructive: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  // Legacy tiers (no longer raised by the CEO-grade gate, but old rows still render).
  plan: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  write: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  safe: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
};

export const DEC_STATUS_BADGE: Record<string, string> = {
  pending: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  denied: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  asked: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
};

/** Plain-language card title — the founder never sees a tool name. */
export function godCardTitle(risk: string): string {
  if (risk === "destructive") return "Confirm with your PIN";
  if (risk === "decision") return "Your call";
  return "Approval";
}

/**
 * director-sms-cockpit-per-director Phase 2: the persona accent + leash subheader
 * rendered at the top of the /god/[token] cockpit when `kind === 'director'`. The
 * SAME god-mode-shared.tsx renders both Eve and director cockpits (CLAUDE.md hard
 * rule for this goal — one cockpit renderer), so a director cockpit picks up the
 * transcript + approvals subcomponents unchanged while the header swaps.
 */
export function DirectorCockpitHeader({
  personaName,
  personaAccent,
  personaRole,
  leashSummary,
}: {
  personaName: string;
  personaAccent?: string;
  personaRole?: string;
  leashSummary: string;
}) {
  const accent = personaAccent && personaAccent.trim() ? personaAccent : "text-indigo-600 dark:text-indigo-400";
  return (
    <header className="flex items-center justify-between py-3">
      <div className="min-w-0">
        <h1 className={`truncate text-lg font-bold ${accent}`}>{personaName}</h1>
        <p className="mt-0.5 truncate text-xs text-zinc-500">
          {personaRole ? `${personaRole} · ` : ""}Leash: {leashSummary}
        </p>
      </div>
    </header>
  );
}

/** The live checklist widget rendered from a role='checklist' message's JSON content. */
export function GodModeChecklist({ content }: { content: string }) {
  let payload: ChecklistPayload | null = null;
  try {
    payload = JSON.parse(content) as ChecklistPayload;
  } catch {
    payload = null;
  }
  if (!payload || !Array.isArray(payload.steps)) return null;
  const done = payload.steps.filter((s) => s.state === "done").length;
  const total = payload.steps.length;
  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-2.5 dark:border-sky-900/50 dark:bg-sky-950/30">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="text-xs font-semibold text-sky-900 dark:text-sky-200">{payload.title}</div>
        <div className="text-[10px] font-medium text-sky-700 dark:text-sky-400">{done}/{total}</div>
      </div>
      <ul className="space-y-1">
        {payload.steps.map((s, i) => (
          <li key={i} className="flex items-center gap-2 text-[11px]">
            <span
              className={
                s.state === "done"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : s.state === "active"
                    ? "animate-pulse text-sky-600 dark:text-sky-400"
                    : "text-zinc-300 dark:text-zinc-600"
              }
            >
              {s.state === "done" ? "✓" : s.state === "active" ? "◐" : "○"}
            </span>
            <span
              className={
                s.state === "done"
                  ? "text-zinc-400 line-through dark:text-zinc-500"
                  : s.state === "active"
                    ? "font-medium text-sky-900 dark:text-sky-100"
                    : "text-zinc-500 dark:text-zinc-400"
              }
            >
              {s.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
