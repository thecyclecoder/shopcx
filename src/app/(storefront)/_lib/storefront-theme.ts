/**
 * Shared storefront theming — the CSS custom properties + body font stack
 * that drive per-workspace look-and-feel. The PDP applies the same vars
 * inline in render-page.tsx; the blog reuses this helper so the two
 * surfaces render with identical typography + brand colors.
 *
 * `.storefront-root` rules in globals.css read these vars: headings inherit
 * the workspace display font, body text uses the OS-native system stack.
 */
import type { CSSProperties } from "react";

export const SYSTEM_BODY_STACK =
  "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif";

export interface StorefrontDesign {
  primary_color?: string | null;
  accent_color?: string | null;
}

/** Build the inline style carrying the workspace theme CSS vars. Pair the
 *  `--storefront-heading-font` from the resolved next/font stack. */
export function storefrontThemeStyle(
  design: StorefrontDesign | null | undefined,
  headingFontStack: string,
): CSSProperties {
  return {
    "--storefront-heading-font": headingFontStack,
    "--storefront-body-font": SYSTEM_BODY_STACK,
    "--storefront-primary": design?.primary_color || "#18181b",
    "--storefront-accent": design?.accent_color || "#10b981",
  } as CSSProperties;
}
