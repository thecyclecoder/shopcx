// Director autonomous behaviors (worker-grading-and-director-management Phase 5) — what the Platform/
// DevOps Director ACTUALLY does without asking, derived from her LEASH (src/lib/agents/platform-director.ts
// LEASH_CATEGORIES + the escort/grade/coach surfaces), NOT the functions/*.md charter. Shown on her
// profile so the operator sees her real autonomous envelope, not an aspirational mandate list. Keep this
// in sync with the leash when it changes (it's the human-legible mirror of the code gate).
//
// Pure presentational + client-safe (no server imports) — the leash itself is code-defined and the same
// for the single live director; this is its plain-English description, gated on her live/autonomous state.

interface Behavior {
  title: string;
  detail: string;
}

/** Auto — what she approves / drives within the leash (each ties to a LEASH category or escort surface). */
const AUTONOMOUS: Behavior[] = [
  { title: "Auto-approves error fixes", detail: "a repair-agent fix for a real bug, once she confirms the authored fix spec is sound + scoped (error_fix)." },
  { title: "Auto-approves DB-health fixes", detail: "an index / health fix with no destructive DDL (db_health)." },
  { title: "Auto-approves additive migrations", detail: "an additive, reversible migration — new table/column/index, no DROP/DELETE/data loss (additive_migration)." },
  { title: "Auto-approves a migration + its backfill bundle", detail: "a multi-action request where an additive migration ships with its idempotent, re-runnable backfill — approved atomically (additive_backfill, P8)." },
  { title: "Escorts approved goals", detail: "drives each greenlit goal's unblocked specs through build → merge → fold, on a */15 beat." },
  { title: "Drives stalled work", detail: "board-grooming continues/splits in-flight specs; she queues 0-phase authored fix specs the goal-walk misses." },
  { title: "Grades + coaches workers", detail: "grades every worker's concluded action 1–10 and coaches one whose rollup slips below 7 or drops >1.5." },
];

/** Up — what ALWAYS routes to the CEO (the rail she never crosses). */
const ESCALATES: Behavior[] = [
  { title: "Anything destructive or irreversible", detail: "a DROP/DELETE/data-dropping action — never auto-approved." },
  { title: "A new feature or a new goal", detail: "a 0-phase feature spec (no repair signature) or starting a goal — only the CEO greenlights these." },
  { title: "A non-binary choice", detail: "a register-vs-exempt / campaign decision — a choice isn't auto-decided." },
  { title: "Anything she can't confirm sound", detail: "if the investigation can't confirm it's sound + in-leash, she escalates rather than rubber-stamp." },
];

function List({ items, tone }: { items: Behavior[]; tone: "auto" | "escalate" }) {
  const dot = tone === "auto" ? "bg-green-400" : "bg-amber-400";
  return (
    <ul className="space-y-2">
      {items.map((b, i) => (
        <li key={i} className="flex gap-2.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
          <span className="min-w-0">
            <span className="block text-sm text-zinc-800 dark:text-zinc-200">{b.title}</span>
            <span className="mt-0.5 block text-[12px] text-zinc-400">{b.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function DirectorAutonomy({ autonomous }: { autonomous: boolean }) {
  return (
    <div className="mt-6">
      <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        What she does autonomously
        {autonomous ? (
          <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-300">live</span>
        ) : (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">dormant</span>
        )}
      </h2>
      {!autonomous && (
        <p className="mb-3 text-[12px] text-zinc-400">
          She isn&apos;t live + autonomous yet — these are the calls she&apos;ll make within her leash once you flip her on. Until then everything routes to the CEO inbox.
        </p>
      )}
      <List items={AUTONOMOUS} tone="auto" />
      <h3 className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Always escalates to you</h3>
      <List items={ESCALATES} tone="escalate" />
    </div>
  );
}
