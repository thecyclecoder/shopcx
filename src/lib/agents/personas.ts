/**
 * Agent personas — the reusable director-persona design-system config
 * (agents-hub-role-inboxes spec, Phase 2).
 *
 * ONE reskinnable source of truth for the org-chart cast: each function slug → a
 * persona (name · role label · color · personality · mascot). Keyed by the brain
 * `functions/*.md` slug (+ the special `ceo` seat) so a NEW director inherits a
 * persona by adding one entry here — every other surface (the Agents hub now, the
 * gamified #directors board in M3) reads this, so names/mascots/colors are never
 * hardcoded across components (operational-rules: reskinnable personas).
 *
 * Pure config (no server imports) → safe to import from client components. The
 * mascot is referenced by `mascotId`; the inline SVG components live in
 * src/components/agents/mascots.tsx keyed by that id.
 *
 * Cast (per the goal): 🛠️ Ada/Platform · 🚀 Max/Growth · 🎨 Iris/CMO · 💬 June/CS ·
 * 🧲 Theo/Retention · 👑 You/CEO. See docs/brain/libraries/agent-personas.md.
 */

export type MascotId = "ada" | "max" | "iris" | "june" | "theo" | "ceo" | "default";

export interface AgentPersona {
  /** function slug (e.g. "platform") or "ceo" */
  key: string;
  /** the character name — reskinnable */
  name: string;
  /** display role label (the org-chart seat) */
  role: string;
  /** quick emoji fallback (the goal's shorthand) */
  emoji: string;
  /** one-line voice for the board posts (M3 reuses this) */
  personality: string;
  /** which inline SVG mascot to render */
  mascotId: MascotId;
  /** chip classes — bg + text + border (explicit so Tailwind keeps them) */
  chip: string;
  /** accent dot / badge background */
  dot: string;
  /** mascot tile background ring */
  ring: string;
  /** accent text color for the mascot (inherited via currentColor) */
  accent: string;
}

/**
 * The cast, keyed by function slug + the `ceo` seat. Reskin by editing this map —
 * one entry per director. Colors are explicit class strings (not interpolated) so
 * the Tailwind compiler never purges them.
 */
export const PERSONAS: Record<string, AgentPersona> = {
  ceo: {
    key: "ceo",
    name: "You",
    role: "CEO",
    emoji: "👑",
    personality: "Owns the company objectives — reads one inbox, not N surfaces.",
    mascotId: "ceo",
    chip: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-900/40",
    dot: "bg-amber-500",
    ring: "bg-amber-50 dark:bg-amber-900/20",
    accent: "text-amber-600 dark:text-amber-400",
  },
  platform: {
    key: "platform",
    name: "Ada",
    role: "Platform",
    emoji: "🛠️",
    personality: "Steady, blunt, ships fast — squashes 500s and escorts builds to green.",
    mascotId: "ada",
    chip: "bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-900/40",
    dot: "bg-indigo-500",
    ring: "bg-indigo-50 dark:bg-indigo-900/20",
    accent: "text-indigo-600 dark:text-indigo-400",
  },
  growth: {
    key: "growth",
    name: "Max",
    role: "Growth",
    emoji: "🚀",
    personality: "High-energy experimenter — always testing the next acquisition lever.",
    mascotId: "max",
    chip: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-900/40",
    dot: "bg-emerald-500",
    ring: "bg-emerald-50 dark:bg-emerald-900/20",
    accent: "text-emerald-600 dark:text-emerald-400",
  },
  cmo: {
    key: "cmo",
    name: "Iris",
    role: "CMO",
    emoji: "🎨",
    personality: "Brand-obsessed storyteller — owns the owned + organic voice.",
    mascotId: "iris",
    chip: "bg-pink-100 text-pink-800 border-pink-200 dark:bg-pink-900/30 dark:text-pink-300 dark:border-pink-900/40",
    dot: "bg-pink-500",
    ring: "bg-pink-50 dark:bg-pink-900/20",
    accent: "text-pink-600 dark:text-pink-400",
  },
  cs: {
    key: "cs",
    name: "June",
    role: "CS",
    emoji: "💬",
    personality: "Warm, fast, customer-first — turns tickets into product fixes.",
    mascotId: "june",
    chip: "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-900/40",
    dot: "bg-sky-500",
    ring: "bg-sky-50 dark:bg-sky-900/20",
    accent: "text-sky-600 dark:text-sky-400",
  },
  retention: {
    key: "retention",
    name: "Theo",
    role: "Retention",
    emoji: "🧲",
    personality: "Calm closer — keeps people subscribed, recovers the dunning saves.",
    mascotId: "theo",
    chip: "bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-900/40",
    dot: "bg-violet-500",
    ring: "bg-violet-50 dark:bg-violet-900/20",
    accent: "text-violet-600 dark:text-violet-400",
  },
};

/** A neutral fallback so a NEW function/*.md with no persona entry still renders (brain-driven, no code change required). */
function defaultPersona(slug: string, label?: string): AgentPersona {
  const name = label || slug.replace(/(^|[-_])(\w)/g, (_m, sep, c) => (sep ? " " : "") + c.toUpperCase());
  return {
    key: slug,
    name,
    role: name,
    emoji: "🤖",
    personality: "A director awaiting a persona — add an entry in personas.ts to reskin.",
    mascotId: "default",
    chip: "bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700",
    dot: "bg-zinc-400",
    ring: "bg-zinc-50 dark:bg-zinc-800/40",
    accent: "text-zinc-500 dark:text-zinc-400",
  };
}

/** Resolve a persona by function slug (or "ceo"); falls back to a neutral persona for unknown directors. */
export function getPersona(slug: string, label?: string): AgentPersona {
  return PERSONAS[slug] ?? defaultPersona(slug, label);
}
