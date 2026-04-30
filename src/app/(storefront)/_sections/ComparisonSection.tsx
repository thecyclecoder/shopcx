import type { PageData } from "../_lib/page-data";

export function ComparisonSection({ data }: { data: PageData }) {
  const rows = data.page_content?.comparison_table_rows || [];
  if (rows.length === 0) return null;

  return (
    <section data-section="comparison" className="w-full bg-zinc-50 py-12 sm:py-16">
      <div className="mx-auto max-w-4xl px-5 md:px-8">
        <h2 className="mb-8 text-center text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:text-4xl">
          How we compare
        </h2>
        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead
              style={{ backgroundColor: "var(--storefront-primary)" }}
              className="sticky top-0 text-white"
            >
              <tr>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider">
                  Feature
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider">
                  Us
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider">
                  Generic alternative
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={i}
                  className={`border-t border-zinc-100 ${i % 2 === 0 ? "bg-white" : "bg-zinc-50/50"}`}
                >
                  <td className="px-4 py-3 font-medium text-zinc-900">{row.feature}</td>
                  <td className="px-4 py-3 font-medium text-emerald-700">
                    <span className="inline-flex items-center gap-1.5">
                      <CheckIcon /> {row.us}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-500">
                    <span className="inline-flex items-center gap-1.5">
                      <XIcon /> {row.competitor_generic}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0 text-emerald-600"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0 text-zinc-400"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
