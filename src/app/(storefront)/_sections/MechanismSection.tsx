import type { PageData } from "../_lib/page-data";

export function MechanismSection({ data }: { data: PageData }) {
  const copy = data.page_content?.mechanism_copy;
  if (!copy) return null;

  return (
    <section data-section="mechanism" className="w-full bg-zinc-50 py-12 sm:py-16">
      <div className="mx-auto max-w-3xl px-5 md:px-8">
        <h2 className="mb-4 text-2xl font-bold leading-tight tracking-tight text-zinc-900 sm:text-3xl md:text-4xl">
          Why this works
        </h2>
        <div className="prose prose-zinc prose-lg max-w-none text-zinc-700">
          {copy.split(/\n\n+/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
      </div>
    </section>
  );
}
