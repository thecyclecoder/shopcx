import Link from "next/link";
import { getArchive } from "@/lib/brain-roadmap";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { deriveLifecycleStage } from "@/lib/build-lifecycle";
import LifecycleTimeline from "../LifecycleTimeline";
import AuthoringChat from "../AuthoringChat";
import ArchiveSearch from "./ArchiveSearch";

/**
 * roadmap-archive-split — the archived (folded) specs, on their own page.
 *
 * This list used to render inside a collapsed `<details>` on the roadmap board, which meant every
 * board load paid for it. Measured 2026-07-20: the board fetched the archive TWICE — once inside
 * `getRoadmap` (all 663 specs, then folded rows dropped in JS) and again via `getArchive` (all 659
 * folded specs WITH their joined phases) — 10.27 MB of spec+phases jsonb per cold load, to display
 * four active cards and a collapsed list of titles.
 *
 * Splitting it out means the board fetches only boardable specs, and this page is paid for only when
 * someone actually wants to look up a spec that finished. `getArchive` now reads the typed archive
 * INDEX (slug + title + date, no phases — see [[specs-table]] `listArchivedSpecIndex`), so even this
 * page costs ~0.10 MB rather than 5.11 MB.
 */

// A folded spec's timeline reads ALL FIVE NODES CHECKED (build-card-lifecycle-timeline Phase 2).
// Same stable constant the board used when this list lived there.
const FOLDED_DERIVATION = deriveLifecycleStage({
  status: "folded",
  valePass: true,
  phases: [],
  builtOnBranch: true,
  buildLive: false,
  buildNeedsAttention: false,
  specTestVerdict: "approved",
  specTestHasOpenRegression: false,
  specTestLive: false,
  specTestHasChecks: true,
  securityLive: false,
  securitySurfaced: false,
  securityCompletedClean: true,
});

export default async function RoadmapArchivePage() {
  const workspaceId = await getActiveWorkspaceId();
  const archive = await getArchive(workspaceId ?? undefined);

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Archived specs</h1>
        <div className="flex items-center gap-3">
          <Link href="/dashboard/roadmap/goals" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Goals →
          </Link>
          <Link href="/dashboard/roadmap" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Board view →
          </Link>
        </div>
      </div>
      <p className="mb-5 text-sm text-zinc-500 dark:text-zinc-400">
        Shipped + owner-verified in production, folded into the brain. Reads the folded{" "}
        <code>public.specs</code> rows (status=&apos;folded&apos;). Re-hydrate any of these into a fresh spec.
      </p>

      {archive.length === 0 ? (
        <p className="rounded-lg border border-zinc-200 bg-white/60 px-4 py-6 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
          Nothing archived yet. A spec lands here once it ships, gets owner-verified, and folds into the brain.
        </p>
      ) : (
        <>
          <ArchiveSearch total={archive.length} />
          <ul className="space-y-2 rounded-lg border border-zinc-200 bg-white/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            {archive.map((e, i) => (
              <li key={i} data-spec-search={`${e.title} ${e.specSlug ?? ""} ${e.link} ${e.label}`.toLowerCase()} className="flex flex-col gap-1 rounded-md px-1 py-1.5 text-xs">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-500" />
                  {/* Title → the read-only archived-spec detail page (its phases are fetched there,
                      one spec at a time). Entries from the filesystem fallback have no specs row, so
                      they keep pointing at the brain page. */}
                  <Link
                    href={e.specSlug ? `/dashboard/roadmap/archive/${e.specSlug}` : `/dashboard/brain/${e.link}`}
                    className="font-medium text-zinc-700 hover:text-indigo-600 dark:text-zinc-200 dark:hover:text-indigo-400"
                  >
                    {e.title}
                  </Link>
                  {e.date && <span className="text-zinc-400">verified {e.date}</span>}
                  <span className="text-zinc-300 dark:text-zinc-600">·</span>
                  <Link href={`/dashboard/brain/${e.link}`} className="text-teal-600 hover:underline dark:text-teal-400">
                    {e.label} ↗
                  </Link>
                  <AuthoringChat seed seedSlug={e.link} triggerLabel="New spec from brain" />
                </div>
                <div className="ml-3.5 max-w-md">
                  <LifecycleTimeline derivation={FOLDED_DERIVATION} density="compact" />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
