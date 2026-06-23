/**
 * Director XP card (directors-board-gamified spec, Phase 3).
 *
 * The four gamified stats for one director — specs shipped · bugs fixed · goals escorted · streak —
 * rendered as a compact tile row on the director's row in the Agents hub (atop its board channel) and on
 * its profile page. Counts are DERIVED + display-only (a gamified proxy, never an objective the directors
 * optimize — operational-rules § North star); the data comes from GET /api/developer/agents/xp.
 *
 * See src/lib/agents/director-xp.ts.
 */
"use client";

export interface DirectorXp {
  specsShipped: number;
  bugsFixed: number;
  goalsEscorted: number;
  streak: number;
}

function Stat({ icon, value, label, suffix }: { icon: string; value: number; label: string; suffix?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-baseline gap-1.5">
        <span aria-hidden className="text-sm">
          {icon}
        </span>
        <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</span>
        {suffix && <span className="text-[10px] text-zinc-400">{suffix}</span>}
      </div>
      <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{label}</p>
    </div>
  );
}

/** The XP card. Renders a "no XP yet" hint when every count is zero (a fresh director). */
export function XpCard({ xp }: { xp: DirectorXp }) {
  const empty = xp.specsShipped === 0 && xp.bugsFixed === 0 && xp.goalsEscorted === 0 && xp.streak === 0;
  return (
    <div className="mt-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat icon="🚢" value={xp.specsShipped} label="Specs shipped" />
        <Stat icon="🐛" value={xp.bugsFixed} label="Bugs fixed" />
        <Stat icon="🎯" value={xp.goalsEscorted} label="Goals escorted" />
        <Stat icon="🔥" value={xp.streak} label="Streak" suffix={xp.streak === 1 ? "day" : "days"} />
      </div>
      {empty && (
        <p className="mt-1 text-[11px] text-zinc-400">
          No XP yet — derived (display-only) from merged builds, approved fixes, milestones advanced, and active days.
        </p>
      )}
    </div>
  );
}
