"use client";

/**
 * Shared pricing-mode state for the storefront PDP: subscribe vs.
 * one-time, plus the selected subscription frequency in days.
 *
 * Both the primary PriceTableSection and the BundlePriceTableSection
 * read and write through this context so toggling Subscribe & Save (or
 * picking a new frequency) in one table updates the other live. The
 * customer should never see the two tables disagree on cadence — it
 * confuses the cart logic and breaks the implied "your bundle ships
 * with your coffee, on the same schedule."
 *
 * Seeded in render-page.tsx from the primary product's pricing_rule:
 *   - initialMode: "subscribe" when any tier has a subscribe price,
 *     else "onetime".
 *   - initialFreqDays: the rule's flagged-default frequency, or first.
 */

import { createContext, useContext, useState, type ReactNode } from "react";

interface PricingModeValue {
  mode: "subscribe" | "onetime";
  setMode: (m: "subscribe" | "onetime") => void;
  freqDays: number | null;
  setFreqDays: (d: number | null) => void;
}

const PricingModeContext = createContext<PricingModeValue | null>(null);

export function PricingModeProvider({
  initialMode = "subscribe",
  initialFreqDays = null,
  children,
}: {
  initialMode?: "subscribe" | "onetime";
  initialFreqDays?: number | null;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<"subscribe" | "onetime">(initialMode);
  const [freqDays, setFreqDays] = useState<number | null>(initialFreqDays);

  return (
    <PricingModeContext.Provider value={{ mode, setMode, freqDays, setFreqDays }}>
      {children}
    </PricingModeContext.Provider>
  );
}

/**
 * Returns the shared pricing mode, or null when used outside the
 * provider (e.g. older pages that haven't been wrapped yet). Consumers
 * that need to remain backward-compat should treat a null return as
 * "fall back to local state" — see PriceTableSection.
 */
export function usePricingMode(): PricingModeValue | null {
  return useContext(PricingModeContext);
}
