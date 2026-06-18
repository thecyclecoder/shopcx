import Link from "next/link";
import { getFunctionMap, type Phase, type SpecCard } from "@/lib/brain-roadmap";

// Reads docs/brain/specs at request time — always reflects the live brain.
export const dynamic = "force-dynamic";

const DOT: Record<Phase, string> = {
  planned: "bg-zinc-400",
  in_progress: "bg-amber-500",
  shipped: "bg-emerald-500",
  rejected: "bg-rose-400",
};
const COUNT_ORDER: Phase[] = ["in_progress", "planned", "shipped", "rejected"];
const COUNT_LABEL: Record<Phase, string> = { in_progress: "in progress", planned: "planned", shipped: "shipped", rejected: "cut" };

function CountPills({ counts }: { counts: Record<Phase, number> }) {
  const items = COUNT_ORDER.filter((k) => counts[k] > 0);
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((k) => (
        <span key={k} title={COUNT_LABEL[k]} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          <span className={`h-1.5 w-1.5 rounded-full ${DOT[k]}`} />
          {counts[k]}
        </span>
      ))}
    </div>
  );
}

function SpecChip({ spec }: { spec: SpecCard }) {
  return (
    <Link
      href={`/dashboard/roadmap/${spec.slug}`}
      className="group flex items-start gap-1.5 rounded-md px-1.5 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
    >
      <span className={`mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT[spec.status]}`} />
      <span className="text-xs leading-snug text-zinc-700 group-hover:text-indigo-600 dark:text-zinc-300 dark:group-hover:text-indigo-400">
        {spec.title}
      </span>
    </Link>
  );
}

export default async function RoadmapMapPage() {
  const { functions, unassigned } = await getFunctionMap();

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Taxonomy map</h1>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/dashboard/roadmap/goals" className="text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Goals
          </Link>
          <Link href="/dashboard/roadmap" className="text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Board view →
          </Link>
        </div>
      </div>
      <p className="mb-5 text-sm text-zinc-500 dark:text-zinc-400">
        Every spec grouped by <span className="font-medium">Function → Mandate / Goal → Spec</span> — the big-picture view of what each role is working on. Built from each spec&apos;s owner + parent, so it never drifts.
      </p>

      {functions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          No assigned specs yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {functions.map((f) => (
            <section key={f.fn} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-3 flex items-center justify-between gap-2 border-b border-zinc-100 pb-2 dark:border-zinc-800">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  <Link href={`/dashboard/roadmap/functions/${f.fn}`} className="hover:text-indigo-600 dark:hover:text-indigo-400">
                    {f.label}
                  </Link>
                  <span className="text-xs font-normal tabular-nums text-zinc-400">{f.total}</span>
                </h2>
                <CountPills counts={f.counts} />
              </div>
              <div className="space-y-3">
                {f.groups.map((g) => (
                  <div key={g.parent}>
                    <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                      <span>↳ {g.label}</span>
                      <span className="tabular-nums text-zinc-300 dark:text-zinc-600">{g.specs.length}</span>
                    </div>
                    <div className="-mx-1.5">
                      {g.specs.map((s) => <SpecChip key={s.slug} spec={s} />)}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {unassigned.length > 0 && (
        <section className="mt-5 rounded-xl border border-dashed border-rose-300 bg-rose-50/40 p-4 dark:border-rose-900/50 dark:bg-rose-900/10">
          <h2 className="mb-2 text-sm font-semibold text-rose-700 dark:text-rose-300">
            Orphan specs — no owner ({unassigned.length})
          </h2>
          <div className="-mx-1.5">
            {unassigned.map((s) => <SpecChip key={s.slug} spec={s} />)}
          </div>
        </section>
      )}
    </div>
  );
}
