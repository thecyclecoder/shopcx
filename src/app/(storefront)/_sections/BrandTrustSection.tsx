/**
 * Brand-trust chapter — sits at the bottom of every PDP (added in render-page).
 * Builds trust + legitimacy: who we are (family-run, Austin TX), our quality
 * commitments (Non-GMO, Made in USA, lab-tested, expert-recommended), and the
 * money-back guarantee. Server component — no JS. `data-section` so the Phase-2
 * chapter tracker attributes engagement here too.
 */
import { ShieldIcon } from "../_components/TrustBadge";

interface Props {
  workspaceName: string;
}

const PILLARS: { icon: string; title: string; body: string }[] = [
  { icon: "🌱", title: "Non-GMO", body: "Clean, natural superfood ingredients — never genetically modified." },
  { icon: "🇺🇸", title: "Made in the USA", body: "Crafted in the United States to strict quality and safety standards." },
  { icon: "🔬", title: "Lab Tested", body: "Every batch is third-party lab tested for purity and potency." },
  { icon: "👨‍⚕️", title: "Expert Recommended", body: "Recommended by health experts for safe, long-term daily use." },
  { icon: "🏡", title: "Family-Run", body: "A family-owned business based in Austin, Texas — real people who care." },
  { icon: "💛", title: "30-Day Guarantee", body: "Love it or your money back, no questions asked." },
];

export function BrandTrustSection({ workspaceName }: Props) {
  return (
    <section
      data-section="brand-trust"
      className="w-full bg-zinc-50 py-14 sm:py-20"
    >
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <div
            className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full text-white"
            style={{ backgroundColor: "var(--storefront-primary, #055c3f)" }}
          >
            <ShieldIcon />
          </div>
          <h2
            className="text-2xl font-bold text-zinc-900 sm:text-3xl"
            style={{ fontFamily: "var(--storefront-heading-font)" }}
          >
            Why families trust {workspaceName}
          </h2>
          <p className="mt-4 text-base leading-relaxed text-zinc-600">
            We&apos;re {workspaceName} — a family-run business from Austin, Texas, on a simple
            mission: make natural superfood products you can feel good about taking every day.
            Everything we make is <strong className="font-semibold text-zinc-800">Non-GMO</strong>,{" "}
            <strong className="font-semibold text-zinc-800">made in the USA</strong>,{" "}
            <strong className="font-semibold text-zinc-800">third-party lab tested</strong>, and{" "}
            <strong className="font-semibold text-zinc-800">recommended by health experts</strong>{" "}
            for safe, long-term use. No fillers, no shortcuts — just clean ingredients backed by
            real science and a guarantee that has your back.
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map((p) => (
            <div key={p.title} className="rounded-2xl border border-zinc-200 bg-white p-5 text-center sm:text-left">
              <div className="text-2xl" aria-hidden>{p.icon}</div>
              <h3 className="mt-2 text-base font-semibold text-zinc-900">{p.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-zinc-500">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
