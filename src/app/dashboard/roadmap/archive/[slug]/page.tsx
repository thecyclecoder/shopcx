import Link from "next/link";
import { notFound } from "next/navigation";
import { getSpec } from "@/lib/specs-table";
import { getActiveWorkspaceId } from "@/lib/workspace";

/**
 * roadmap-archive-split — read-only detail view for an ARCHIVED (folded) spec.
 *
 * Why this page exists: `brain-roadmap.getSpec` deliberately returns null for a folded spec
 * ("folded specs are archive territory"), so `/dashboard/roadmap/{slug}` 404s on anything archived.
 * Until now there was no way to read a finished spec's phases in the dashboard at all — the archive
 * list linked to the folded BRAIN page, which is the distilled knowledge, not the spec that shipped.
 *
 * Why it's cheap: the archive LISTING carries no phases (see [[specs-table]]
 * `listArchivedSpecIndex`), and the phases are fetched here — one `getSpec` call, one spec, ~7.8 KB,
 * only for the spec someone actually opened. That's the whole point of splitting the index from the
 * detail: 659 rows of phase jsonb up front bought nothing, one row on click buys everything.
 *
 * Read-only by construction. A folded spec is history: no status controls, no build button, no
 * phase mutation. It renders what shipped, and links out to the brain page and the merged PR.
 */

const STATUS_PILL: Record<string, string> = {
  shipped: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  rejected: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  in_progress: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  planned: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

const GH_REPO = "thecyclecoder/shopcx";

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="text-xs">
      <span className="font-semibold uppercase tracking-wide text-zinc-400">{label}</span>
      <p className="mt-0.5 whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">{value}</p>
    </div>
  );
}

export default async function ArchivedSpecPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspaceId = await getActiveWorkspaceId();
  // The SDK `getSpec` (unlike the brain-roadmap wrapper) does NOT filter folded — that's exactly why
  // this page can render what the board can't.
  const spec = workspaceId ? await getSpec(workspaceId, slug) : null;
  if (!spec) notFound();

  return (
    <div className="mx-auto w-full max-w-4xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
            Archived
          </span>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{spec.title}</h1>
        </div>
        <Link href="/dashboard/roadmap/archive" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
          ← All archived specs
        </Link>
      </div>

      <p className="mt-1 font-mono text-xs text-zinc-400">{spec.slug}</p>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
        {spec.owner && <span>owner <span className="text-zinc-700 dark:text-zinc-200">{spec.owner}</span></span>}
        {spec.parent_ref && <span>parent <span className="text-zinc-700 dark:text-zinc-200">{spec.parent_kind}:{spec.parent_ref}</span></span>}
        <span>folded <span className="text-zinc-700 dark:text-zinc-200">{(spec.updated_at || "").slice(0, 10)}</span></span>
        {spec.merged_pr && (
          <a href={`https://github.com/${GH_REPO}/pull/${spec.merged_pr}`} target="_blank" rel="noreferrer" className="text-teal-600 hover:underline dark:text-teal-400">
            PR #{spec.merged_pr} ↗
          </a>
        )}
        <Link href={`/dashboard/brain/lifecycles/${spec.slug}`} className="text-teal-600 hover:underline dark:text-teal-400">
          Brain page ↗
        </Link>
      </div>

      {(spec.why || spec.what || spec.summary) && (
        <div className="mt-5 space-y-3 rounded-lg border border-zinc-200 bg-white/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <Field label="Why" value={spec.why} />
          <Field label="What" value={spec.what} />
          <Field label="Summary" value={spec.summary} />
        </div>
      )}

      <h2 className="mt-6 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Phases <span className="ml-1 tabular-nums text-zinc-400">{spec.phases.length}</span>
      </h2>
      <ol className="mt-2 space-y-3">
        {spec.phases.map((p) => (
          <li key={p.id} className="rounded-lg border border-zinc-200 bg-white/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums text-xs text-zinc-400">P{p.position}</span>
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{p.title}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_PILL[p.status] ?? STATUS_PILL.planned}`}>
                {p.status}
              </span>
              {p.pr && (
                <a href={`https://github.com/${GH_REPO}/pull/${p.pr}`} target="_blank" rel="noreferrer" className="text-xs text-teal-600 hover:underline dark:text-teal-400">
                  #{p.pr} ↗
                </a>
              )}
              {p.merge_sha && <span className="font-mono text-[11px] text-zinc-400">{p.merge_sha.slice(0, 9)}</span>}
            </div>
            <div className="mt-2 space-y-2">
              <Field label="Why" value={p.why} />
              <Field label="What" value={p.what} />
              <Field label="Verification" value={p.verification} />
              {p.body && (
                <details>
                  <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-zinc-400">Body</summary>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300">{p.body}</p>
                </details>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
