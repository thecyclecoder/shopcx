/**
 * Persona chip + mascot avatar + live/autonomous badge
 * (agents-hub-role-inboxes spec, Phase 2).
 *
 * The reusable building blocks every role row reuses: a colored mascot avatar, a
 * name/role chip, and the live/autonomous badge. The autonomy FLAG itself lands in
 * M2 (approval-routing-engine) — here it's a presentational prop that defaults to
 * the M1 reality: no director is live, so everything routes to the CEO.
 *
 * See src/lib/agents/personas.ts + src/components/agents/mascots.tsx.
 */
"use client";
import { useState } from "react";
import type { AgentPersona } from "@/lib/agents/personas";
import { Mascot } from "@/components/agents/mascots";

/** The avatar tile — the real headshot photo when present, else the colored SVG mascot.
 *  Falls back to the mascot if the headshot fails to load (e.g. not yet uploaded). */
export function PersonaAvatar({ persona, size = 40 }: { persona: AgentPersona; size?: number }) {
  const [imgError, setImgError] = useState(false);
  if (persona.avatarUrl && !imgError) {
    return (
      <img
        src={persona.avatarUrl}
        alt={`${persona.name} — ${persona.role}`}
        title={`${persona.name} — ${persona.role}`}
        width={size + 12}
        height={size + 12}
        className={`inline-block shrink-0 rounded-xl object-cover ring-1 ring-black/5 dark:ring-white/10`}
        style={{ width: size + 12, height: size + 12 }}
        loading="lazy"
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-xl ${persona.ring} ${persona.accent}`}
      style={{ width: size + 12, height: size + 12 }}
    >
      <Mascot id={persona.mascotId} size={size} title={`${persona.name} — ${persona.role}`} />
    </span>
  );
}

/** A compact name/role pill (mascot emoji + name). */
export function PersonaChip({ persona }: { persona: AgentPersona }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${persona.chip}`}>
      <span aria-hidden>{persona.emoji}</span>
      {persona.name}
      <span className="opacity-60">· {persona.role}</span>
    </span>
  );
}

export type AgentStatus = "live" | "autonomous" | "offline";

/**
 * The live/autonomous badge. In M1 every director is `offline` (no director is
 * automated yet → its approvals route up to the CEO). M2 flips this per-function.
 */
export function StatusBadge({ status }: { status: AgentStatus }) {
  if (status === "autonomous") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> autonomous
      </span>
    );
  }
  if (status === "live") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
        <span className="h-1.5 w-1.5 rounded-full bg-sky-500" /> live
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
      <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" /> routes to CEO
    </span>
  );
}
