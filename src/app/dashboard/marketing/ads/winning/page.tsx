"use client";

/**
 * Winning Static-Creative Finder — Phase 5 surface.
 *
 * Two views:
 *   - Pattern matrix (the deliverable): slot patterns repeating across multiple
 *     INDEPENDENT brands + the ranked hook×mechanism×proof×offer test matrix.
 *   - Browse: the deconstructed winners (skeletons), with shortlist/archive.
 *
 * Creatives display through the authenticated proxy (/api/ads/creative-finder/media)
 * — we never re-host a competitor asset. docs/brain/specs/winning-static-creative-finder.md.
 */
import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Skeleton {
  id: string;
  advertiser: string | null;
  title: string | null;
  image_url: string | null;
  thumb_url: string | null;
  media_type: string;
  format: string | null;
  framework: string | null;
  hook: string | null;
  mechanism_claim: string | null;
  proof: string | null;
  offer: string | null;
  days_running: number | null;
  heat: number | null;
  seed_keyword: string | null;
  seed_kind: string | null;
  status: string;
}

interface SlotPattern {
  slot: string;
  label: string;
  brandCount: number;
  brands: string[];
  maxDaysRunning: number;
  exampleValues: string[];
}

interface TestMatrixRow {
  hook: string;
  mechanism_claim: string;
  proof: string;
  offer: string;
  score: number;
}

interface Matrix {
  generatedFrom: number;
  brandCount: number;
  slotPatterns: SlotPattern[];
  testMatrix: TestMatrixRow[];
}

const SLOT_LABEL: Record<string, string> = {
  hook: "Hook",
  mechanism_claim: "Mechanism",
  proof: "Proof",
  offer: "Offer",
};

export default function WinningStaticsPage() {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<"patterns" | "browse">("patterns");
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [skeletons, setSkeletons] = useState<Skeleton[]>([]);
  const [loading, setLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);

  const proxy = useCallback(
    (u: string | null) =>
      u ? `/api/ads/creative-finder/media?workspaceId=${workspace.id}&u=${encodeURIComponent(u)}` : null,
    [workspace.id],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const [m, s] = await Promise.all([
      fetch(`/api/ads/creative-finder/patterns?workspaceId=${workspace.id}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/ads/creative-finder?workspaceId=${workspace.id}`).then((r) => (r.ok ? r.json() : [])),
    ]);
    setMatrix(m);
    setSkeletons(s);
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  const sweep = useCallback(async () => {
    setSweeping(true);
    await fetch(`/api/ads/creative-finder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    setSweeping(false);
    alert("Sweep queued. Skeletons appear as AdLibrary pulls + vision complete (a few minutes).");
  }, [workspace.id]);

  const setStatus = useCallback(
    async (id: string, status: string) => {
      setSkeletons((prev) => prev.map((x) => (x.id === id ? { ...x, status } : x)));
      await fetch(`/api/ads/creative-finder/${id}?workspaceId=${workspace.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
    },
    [workspace.id],
  );

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Winning statics</h1>
        <button
          onClick={sweep}
          disabled={sweeping}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {sweeping ? "Queuing…" : "Run sweep now"}
        </button>
      </div>
      <p className="mb-6 text-sm text-zinc-500">
        Reverse-engineered structure of long-running competitor + category ads. The signal is a slot
        pattern repeating across multiple <em>independent</em> brands — never any single ad. Structure only;
        we never copy a creative.
      </p>

      <div className="mb-6 flex gap-2 border-b border-zinc-200 dark:border-zinc-800">
        {(["patterns", "browse"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            }`}
          >
            {t === "patterns" ? "Pattern matrix" : `Browse (${skeletons.length})`}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : tab === "patterns" ? (
        <PatternView matrix={matrix} />
      ) : (
        <BrowseView skeletons={skeletons} proxy={proxy} setStatus={setStatus} />
      )}
    </div>
  );
}

function PatternView({ matrix }: { matrix: Matrix | null }) {
  if (!matrix || matrix.generatedFrom === 0)
    return (
      <p className="text-sm text-zinc-500">
        No skeletons analyzed yet. Run a sweep to pull and deconstruct winners.
      </p>
    );

  const bySlot = (slot: string) => matrix.slotPatterns.filter((p) => p.slot === slot);

  return (
    <div className="space-y-8">
      <p className="text-sm text-zinc-500">
        From <strong>{matrix.generatedFrom}</strong> analyzed winners across{" "}
        <strong>{matrix.brandCount}</strong> independent brands.
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        {["hook", "mechanism_claim", "proof", "offer"].map((slot) => {
          const patterns = bySlot(slot);
          return (
            <div key={slot} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {SLOT_LABEL[slot]} patterns
              </h3>
              {patterns.length === 0 ? (
                <p className="text-xs text-zinc-400">No cross-brand repetition yet.</p>
              ) : (
                <ul className="space-y-3">
                  {patterns.map((p, i) => (
                    <li key={i} className="text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-zinc-800 dark:text-zinc-200">{p.label}</span>
                        <span className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                          {p.brandCount} brands
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500">
                        {p.brands.join(", ")} · max {p.maxDaysRunning}d running
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Test matrix (ranked by cross-brand repetition)
        </h3>
        {matrix.testMatrix.length === 0 ? (
          <p className="text-xs text-zinc-400">Not enough repeating slots to build a matrix yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-3 py-2">Hook</th>
                  <th className="px-3 py-2">Mechanism</th>
                  <th className="px-3 py-2">Proof</th>
                  <th className="px-3 py-2">Offer</th>
                  <th className="px-3 py-2">Score</th>
                </tr>
              </thead>
              <tbody>
                {matrix.testMatrix.map((r, i) => (
                  <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-3 py-2">{r.hook}</td>
                    <td className="px-3 py-2">{r.mechanism_claim}</td>
                    <td className="px-3 py-2">{r.proof}</td>
                    <td className="px-3 py-2">{r.offer}</td>
                    <td className="px-3 py-2 font-semibold">{r.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function BrowseView({
  skeletons,
  proxy,
  setStatus,
}: {
  skeletons: Skeleton[];
  proxy: (u: string | null) => string | null;
  setStatus: (id: string, status: string) => void;
}) {
  if (skeletons.length === 0)
    return <p className="text-sm text-zinc-500">No winners analyzed yet. Run a sweep.</p>;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {skeletons.map((s) => {
        // Prefer OUR stored downscaled copy (fast, served from storage); fall back to the live proxy
        // only for legacy rows that predate thumb_path.
        const src = s.thumb_url ?? proxy(s.image_url);
        return (
          <div
            key={s.id}
            className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
          >
            <div className="aspect-square w-full bg-zinc-100 dark:bg-zinc-800">
              {src ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={src} alt={s.title || s.advertiser || "creative"} className="h-full w-full object-contain" />
              ) : null}
            </div>
            <div className="space-y-2 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">{s.advertiser || "—"}</span>
                <span className="shrink-0 text-xs text-zinc-500">{s.days_running ?? "?"}d</span>
              </div>
              <div className="flex flex-wrap gap-1 text-xs">
                {s.format ? <Tag>{s.format}</Tag> : null}
                {s.framework ? <Tag>{s.framework}</Tag> : null}
                {s.seed_kind ? <Tag>{s.seed_kind}</Tag> : null}
              </div>
              <Slot k="Hook" v={s.hook} />
              <Slot k="Mechanism" v={s.mechanism_claim} />
              <Slot k="Proof" v={s.proof} />
              <Slot k="Offer" v={s.offer} />
              <div className="flex gap-2 pt-1">
                {s.status === "shortlisted" ? (
                  <button
                    onClick={() => setStatus(s.id, "analyzed")}
                    className="rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                  >
                    ★ Shortlisted
                  </button>
                ) : (
                  <button
                    onClick={() => setStatus(s.id, "shortlisted")}
                    className="rounded-md bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    ☆ Shortlist
                  </button>
                )}
                <button
                  onClick={() => setStatus(s.id, "archived")}
                  className="rounded-md px-2 py-1 text-xs font-medium text-zinc-400 hover:text-red-600"
                >
                  Archive
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      {children}
    </span>
  );
}

function Slot({ k, v }: { k: string; v: string | null }) {
  if (!v) return null;
  return (
    <p className="text-xs">
      <span className="font-semibold text-zinc-500">{k}: </span>
      <span className="text-zinc-700 dark:text-zinc-300">{v}</span>
    </p>
  );
}
