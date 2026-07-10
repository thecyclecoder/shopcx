import type { Phase } from "@/lib/brain-roadmap";

/** One verification check on a phase, with its live green/tested state. */
export interface PhaseCheckView {
  text: string;
  kind: "auto" | "human";
  green: boolean;
  via: "agent" | "owner" | null;
}

/** A phase enriched with everything the detail page shows: intent, body (pre-rendered), checks. */
export interface PhaseDetailView {
  position: number;
  title: string;
  status: Phase;
  built: boolean;
  pr: number | null;
  kind: string;
  why: string | null;
  what: string | null;
  bodyHtml: string | null;
  checks: PhaseCheckView[];
}

const GH_REPO = "thecyclecoder/shopcx";

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  planned: { label: "Planned", cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" },
  in_progress: { label: "Building", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  built: { label: "Built", cls: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300" },
  shipped: { label: "Shipped", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" },
  rejected: { label: "Cut", cls: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400" },
};

function pillFor(p: PhaseDetailView): { label: string; cls: string } {
  if (p.built) return STATUS_PILL.built;
  return STATUS_PILL[p.status] ?? STATUS_PILL.planned;
}

/**
 * Per-phase detail block for the spec detail page (spec-detail-shows-phases-and-verifications). Renders
 * every phase with its status, plain-language why/what, body, and its OWN verification checks grouped by
 * `phasePosition` with live green/tested state — the data the page previously dropped (it flattened all
 * checks into one card and never surfaced per-phase body/why/what). Pure presentational server component;
 * the page pre-renders `bodyHtml` (trusted internal markdown) and computes green state.
 */
export default function SpecPhasesDetail({ phases }: { phases: PhaseDetailView[] }) {
  if (!phases.length) return null;
  return (
    <section className="mb-5 space-y-3">
      <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Phases &amp; verification
      </h2>
      {phases.map((p) => {
        const pill = pillFor(p);
        const greenCount = p.checks.filter((c) => c.green).length;
        return (
          <div
            key={p.position}
            className="rounded-lg border border-zinc-200 bg-white/70 p-4 dark:border-zinc-800 dark:bg-zinc-900/40"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {/^phase\b/i.test(p.title.trim()) ? p.title.trim() : `Phase ${p.position} — ${p.title}`}
              </span>
              {p.kind === "fix" && (
                <span className="inline-flex items-center rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 dark:bg-orange-900/30 dark:text-orange-300">
                  fix
                </span>
              )}
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${pill.cls}`}>
                {pill.label}
              </span>
              {p.pr && (
                <a
                  href={`https://github.com/${GH_REPO}/pull/${p.pr}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/50"
                >
                  #{p.pr}
                </a>
              )}
            </div>

            {p.what && <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{p.what}</p>}
            {p.why && (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
                  Why this phase
                </summary>
                <p className="mt-1 whitespace-pre-line text-zinc-700 dark:text-zinc-300">{p.why}</p>
              </details>
            )}

            {p.bodyHtml && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
                  Build detail
                </summary>
                <article
                  className="prose prose-sm prose-zinc mt-2 max-w-none prose-headings:font-semibold prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none prose-table:text-xs"
                  dangerouslySetInnerHTML={{ __html: p.bodyHtml }}
                />
              </details>
            )}

            <div className="mt-3 border-t border-zinc-100 pt-2 dark:border-zinc-800">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Verification
                </span>
                {p.checks.length > 0 && (
                  <span className="text-[11px] text-zinc-400">
                    {greenCount}/{p.checks.length} green
                  </span>
                )}
              </div>
              {p.checks.length === 0 ? (
                <p className="text-xs italic text-zinc-400">No verification checks on this phase.</p>
              ) : (
                <ul className="space-y-1">
                  {p.checks.map((c, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                      <span className="mt-0.5 shrink-0" title={c.green ? "Verified" : "Not yet verified"}>
                        {c.green ? "✅" : "◻️"}
                      </span>
                      <span className="min-w-0">
                        {c.text}
                        <span className="ml-1.5 inline-flex items-center rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                          {c.kind === "human" ? "human" : "auto"}
                        </span>
                        {c.green && c.via && (
                          <span className="ml-1 text-[10px] text-zinc-400">
                            ({c.via === "owner" ? "you tested" : "agent"})
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
