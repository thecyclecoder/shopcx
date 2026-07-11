/**
 * Pure patch predicates for the theme-side crisis availability lever
 * ([[../../docs/brain/libraries/shopify-theme]] — Phase 2 of the
 * `suppress-strawberry-lemonade-superfood-tabs` spec).
 *
 * Split from `scripts/hide-strawberry-lemonade-superfood-tabs-theme.ts` so the
 * "add SL alongside MB in the same shape" transform is unit-testable without
 * touching Supabase, Shopify, or GitHub. Founder (2026-07-11) confirmed the
 * MB exclusion in the Superfoods theme lives in the quantity-breaks snippet
 * as a Liquid `variant.id ==` comparison — NOT a Dawn hidden_variants
 * section setting — so `patchLiquidVariantExclusion` is the primary patcher.
 *
 * Every patcher is idempotent: a file that ALREADY contains the SL id is
 * returned as null.
 */

/**
 * Extend a Liquid variant.id comparison so it also matches `sl`.
 *
 *   `variant.id == MB`   →   `variant.id == MB or variant.id == SL`
 *   `variant.id != MB`   →   `variant.id != MB and variant.id != SL`
 *
 * Rationale: the customize-flavor block uses these expressions to either
 * SKIP MB from the flavor list (`unless variant.id == MB`) or continue past
 * it (`if variant.id == MB %}{% continue`). The extended expression
 * preserves exactly that semantic for SL — no matter what the surrounding
 * wrap is (`unless`, `if`, boolean cond, `when`), the two comparisons
 * compose the right way.
 *
 * Whole-token guard prevents patching a longer numeric that happens to
 * contain `mb` as a substring. Idempotent — a file that already contains
 * `sl` returns null.
 */
export function patchLiquidVariantExclusion(content: string, mb: string, sl: string): string | null {
  if (!mb || !sl) return null;
  if (content.includes(sl)) return null;
  if (!content.includes(mb)) return null;
  let out = content;

  const eqRx = new RegExp(`(variant\\.id\\s*==\\s*)${mb}(?![0-9])`, "g");
  if (eqRx.test(out)) {
    out = out.replace(new RegExp(`(variant\\.id\\s*==\\s*)${mb}(?![0-9])`, "g"), `$1${mb} or variant.id == ${sl}`);
  }

  const neRx = new RegExp(`(variant\\.id\\s*!=\\s*)${mb}(?![0-9])`, "g");
  if (neRx.test(out)) {
    out = out.replace(new RegExp(`(variant\\.id\\s*!=\\s*)${mb}(?![0-9])`, "g"), `$1${mb} and variant.id != ${sl}`);
  }

  return out === content ? null : out;
}

/**
 * Fallback for JSON-shaped lists (Dawn `hidden_variants` block, template JSON).
 * Inserts `sl` alongside every occurrence of `mb`.
 *   `"MB"` becomes `"MB","SL"` (JSON array entry).
 *   Bare CSV `MB` becomes `MB,SL` (whole-token guard).
 */
export function patchJsonForSl(content: string, mb: string, sl: string): string | null {
  if (!mb || !sl) return null;
  if (content.includes(sl)) return null;
  if (!content.includes(mb)) return null;
  let out = content;
  if (out.includes(`"${mb}"`)) {
    out = out.replaceAll(`"${mb}"`, `"${mb}","${sl}"`);
  } else {
    const rx = new RegExp(`(^|[\\s,\\[])${mb}(?=[\\s,\\]"']|$)`, "g");
    out = out.replace(rx, `$1${mb},${sl}`);
  }
  return out === content ? null : out;
}

/**
 * Fallback for the Dawn Product section's `"hidden_variants": "…"` string
 * setting. Appends `sl` to every hidden_variants CSV that doesn't already
 * contain it. Preserves the original spacing around the colon.
 */
export function patchHiddenVariantsSetting(content: string, sl: string): string | null {
  if (!sl) return null;
  let changed = false;
  const out = content.replace(/("hidden_variants"\s*:\s*")([^"]*)(")/g, (_, head: string, csv: string, tail: string) => {
    if (csv.split(",").map((s) => s.trim()).filter(Boolean).includes(sl)) return `${head}${csv}${tail}`;
    changed = true;
    const nextCsv = csv.trim().length ? `${csv},${sl}` : sl;
    return `${head}${nextCsv}${tail}`;
  });
  return changed ? out : null;
}
