"use client";

import { useState } from "react";
import type { PageData } from "../_lib/page-data";
import { ShopCTA } from "../_components/ShopCTA";

export function FAQSection({ data }: { data: PageData }) {
  const items = data.page_content?.faq_items || [];
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  if (items.length === 0) return null;

  const lowestPrice = data.pricing_tiers.length
    ? Math.min(...data.pricing_tiers.map((t) => t.subscribe_price_cents ?? t.price_cents))
    : null;

  return (
    <section data-section="faq" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-3xl px-5 md:px-8">
        <h2 className="mb-8 text-center text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:text-4xl">
          Frequently asked questions
        </h2>
        <div className="divide-y divide-zinc-200 overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          {items.map((item, i) => {
            const open = openIdx === i;
            return (
              <div key={i}>
                <button
                  type="button"
                  onClick={() => setOpenIdx(open ? null : i)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-zinc-50"
                >
                  <span className="text-base font-medium text-zinc-900">
                    {item.question}
                  </span>
                  <span
                    className={`flex-shrink-0 text-zinc-400 transition-transform ${
                      open ? "rotate-180" : ""
                    }`}
                    aria-hidden="true"
                  >
                    <ChevronDown />
                  </span>
                </button>
                {open && (
                  <div className="px-5 pb-5 text-sm leading-relaxed text-zinc-700">
                    {item.answer}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-10 flex justify-center md:mt-14">
          <ShopCTA lowestPriceCents={lowestPrice} align="center" />
        </div>
      </div>
    </section>
  );
}

function ChevronDown() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
