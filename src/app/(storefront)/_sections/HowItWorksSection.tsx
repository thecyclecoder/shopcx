import type { PageData } from "../_lib/page-data";

export function HowItWorksSection({ data }: { data: PageData }) {
  const steps = data.how_it_works;
  if (steps.length === 0) return null;

  return (
    <section data-section="how-it-works" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-5xl px-5 md:px-8">
        <h2 className="mb-8 text-center text-2xl font-bold leading-tight tracking-tight text-zinc-900 sm:text-3xl md:text-4xl md:mb-12">
          How it works
        </h2>
        <ol className="flex flex-col gap-6 md:flex-row md:gap-4">
          {steps.map((step, idx) => (
            <li
              key={step.id}
              className="relative flex flex-1 flex-col items-start text-left md:items-center md:text-center"
            >
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-900 text-lg font-bold text-white">
                {idx + 1}
              </div>
              <h3 className="mb-2 text-lg font-semibold text-zinc-900 sm:text-xl">
                {step.headline}
              </h3>
              <p className="text-base text-zinc-600">{step.body}</p>
              {idx < steps.length - 1 && (
                <div
                  className="absolute left-6 top-12 hidden h-px w-full bg-zinc-200 md:block"
                  aria-hidden="true"
                />
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
