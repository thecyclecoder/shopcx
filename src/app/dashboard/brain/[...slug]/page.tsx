import Link from "next/link";
import { notFound } from "next/navigation";
import { renderBrainDoc } from "@/lib/brain-tree";


export default async function BrainDoc({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const doc = await renderBrainDoc(slug.join("/"));
  if (!doc) notFound();

  return (
    <div>
      <div className="mb-4">
        <Link href="/dashboard/brain" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
          ← Brain index
        </Link>
        <code className="ml-2 text-xs text-zinc-400">docs/brain/{doc.slug}.md</code>
      </div>
      <article
        className="prose prose-sm prose-zinc max-w-none prose-headings:font-semibold prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none prose-table:text-xs"
        dangerouslySetInnerHTML={{ __html: doc.html }}
      />
    </div>
  );
}
