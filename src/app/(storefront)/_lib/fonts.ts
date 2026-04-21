/**
 * Storefront font allowlist.
 *
 * next/font requires build-time registration, so runtime-switchable
 * fonts need a pre-registered set. Each workspace picks one via its
 * `storefront_font` setting; the `storefrontFont()` helper resolves
 * the CSS variable + fontFamily for a given key.
 *
 * To add a font: import it from next/font/google here, register it in
 * the FONTS map, and it becomes selectable in Settings → Storefront
 * Design.
 */

import {
  Inter,
  Montserrat,
  Poppins,
  Lato,
  Open_Sans,
  Work_Sans,
  Nunito_Sans,
  Playfair_Display,
} from "next/font/google";

// Preload=true on the default only — other fonts load lazily when
// their className is applied (workspace-specific selection).
//
// adjustFontFallback: "Arial" generates a size-adjusted fallback so
// the swap from fallback → Montserrat doesn't shift layout. Without
// this the fallback uses Arial's raw metrics and the text block can
// grow or shrink 10-30px total across the hero on font load.
const montserrat = Montserrat({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "600", "700"],
  variable: "--font-montserrat",
  preload: true,
  adjustFontFallback: "Arial",
});
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter", preload: false });
const poppins = Poppins({ subsets: ["latin"], display: "swap", weight: ["400", "600", "700"], variable: "--font-poppins", preload: false });
const lato = Lato({ subsets: ["latin"], display: "swap", weight: ["400", "700"], variable: "--font-lato", preload: false });
const openSans = Open_Sans({ subsets: ["latin"], display: "swap", variable: "--font-open-sans", preload: false });
const workSans = Work_Sans({ subsets: ["latin"], display: "swap", variable: "--font-work-sans", preload: false });
const nunitoSans = Nunito_Sans({ subsets: ["latin"], display: "swap", variable: "--font-nunito-sans", preload: false });
const playfair = Playfair_Display({ subsets: ["latin"], display: "swap", variable: "--font-playfair", preload: false });

export interface StorefrontFontOption {
  key: string;
  label: string;
  variable: string;
  className: string;
  stack: string;
}

export const FONTS: Record<string, StorefrontFontOption> = {
  montserrat: {
    key: "montserrat",
    label: "Montserrat",
    variable: montserrat.variable,
    className: montserrat.variable,
    stack: "var(--font-montserrat), system-ui, sans-serif",
  },
  inter: {
    key: "inter",
    label: "Inter",
    variable: inter.variable,
    className: inter.variable,
    stack: "var(--font-inter), system-ui, sans-serif",
  },
  poppins: {
    key: "poppins",
    label: "Poppins",
    variable: poppins.variable,
    className: poppins.variable,
    stack: "var(--font-poppins), system-ui, sans-serif",
  },
  lato: {
    key: "lato",
    label: "Lato",
    variable: lato.variable,
    className: lato.variable,
    stack: "var(--font-lato), system-ui, sans-serif",
  },
  "open-sans": {
    key: "open-sans",
    label: "Open Sans",
    variable: openSans.variable,
    className: openSans.variable,
    stack: "var(--font-open-sans), system-ui, sans-serif",
  },
  "work-sans": {
    key: "work-sans",
    label: "Work Sans",
    variable: workSans.variable,
    className: workSans.variable,
    stack: "var(--font-work-sans), system-ui, sans-serif",
  },
  "nunito-sans": {
    key: "nunito-sans",
    label: "Nunito Sans",
    variable: nunitoSans.variable,
    className: nunitoSans.variable,
    stack: "var(--font-nunito-sans), system-ui, sans-serif",
  },
  playfair: {
    key: "playfair",
    label: "Playfair Display",
    variable: playfair.variable,
    className: playfair.variable,
    stack: "var(--font-playfair), Georgia, serif",
  },
};

export const DEFAULT_FONT_KEY = "montserrat";

/**
 * Resolve a font key to its next/font metadata. Falls back to the
 * default (Montserrat) when the key is unknown or missing.
 */
export function storefrontFont(key: string | null | undefined): StorefrontFontOption {
  if (key && FONTS[key]) return FONTS[key];
  return FONTS[DEFAULT_FONT_KEY];
}

/**
 * Combined className that loads every pre-registered font variable.
 * Used at the layout level so any page can reference any font without
 * extra imports.
 */
export const ALL_FONT_VARIABLES = Object.values(FONTS)
  .map((f) => f.variable)
  .join(" ");
