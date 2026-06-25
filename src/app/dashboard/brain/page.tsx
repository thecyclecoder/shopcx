import Link from "next/link";
import { getBrainTree } from "@/lib/brain-tree";


const ORDER: Record<string, number> = {
  "(root)": 0, lifecycles: 1, dashboard: 2, tables: 3, libraries: 4,
  inngest: 5, integrations: 6, recipes: 7, specs: 8, journeys: 9, playbooks: 10,
};

export default async function BrainIndex() {
  const { folders, files } = await getBrainTree();
  const names = Object.keys(folders).sort((a, b) => (ORDER[a] ?? 20) - (ORDER[b] ?? 20) || a.localeCompare(b));

  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Brain</h1>
      <p className="mb-5 text-sm text-zinc-500 dark:text-zinc-400">
        The ShopCX system map — {files.length} pages across {names.length} sections. Start at{" "}
        <Link href="/dashboard/brain/README" className="text-indigo-600 hover:underline">README</Link>.
      </p>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {names.map((name) => (
          <div key={name} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              {name} <span className="text-zinc-300 dark:text-zinc-600">({folders[name].length})</span>
            </div>
            <ul className="space-y-0.5 text-sm">
              {folders[name].map((f) => (
                <li key={f.slug}>
                  <Link href={`/dashboard/brain/${f.slug}`} className="text-zinc-700 hover:text-indigo-600 dark:text-zinc-300 dark:hover:text-indigo-400">
                    {f.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
