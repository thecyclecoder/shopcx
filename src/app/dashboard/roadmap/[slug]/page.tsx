import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import { getSpec, listSpecSlugs, type Phase } from "@/lib/brain-roadmap";
import StatusControl from "../StatusControl";
import AuthoringChat from "../AuthoringChat";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<Phase, string> = { planned: "Planned", in_progress: "In progress", shipped: "Shipped" };
const STATUS_BADGE: Record<Phase, string> = {
  planned: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  in_progress: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  shipped: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
};

/** [[spec-slug]] / [[../lifecycles/x|alias]] → a link to the spec detail page if it's a spec, else plain text. */
function preprocessWikilinks(md: string, specSlugs: string[]): string {
  return md.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const [targetRaw, alias] = inner.split("|");
    const base = targetRaw.trim().replace(/^.*\//, "").replace(/\.md$/, "");
    const label = (alias || base).trim();
    return specSlugs.includes(base) ? `[${label}](/dashboard/roadmap/${base})` : label;
  });
}

export default async function SpecDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [spec, specSlugs] = await Promise.all([getSpec(slug), listSpecSlugs()]);
  if (!spec) notFound();

  // Trusted internal content (our own brain markdown), owner-only page → marked → prose.
  const html = await marked.parse(preprocessWikilinks(spec.raw, specSlugs));

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <Link href="/dashboard/roadmap" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
        ← Roadmap
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[spec.card.status]}`}>
          {STATUS_LABEL[spec.card.status]}
        </span>
        <code className="text-xs text-zinc-400">docs/brain/specs/{slug}.md</code>
        <StatusControl slug={slug} status={spec.card.status} />
        <AuthoringChat slug={slug} triggerLabel="Refine with Opus" />
      </div>
      <article
        className="prose prose-sm prose-zinc mt-5 max-w-none prose-headings:font-semibold prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none prose-table:text-xs"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
