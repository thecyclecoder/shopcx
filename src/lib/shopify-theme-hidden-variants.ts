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

// ── Reverse patchers (Marco / Phase 1: setStorefrontAvailability available=true) ─
//
// The forward patchers above HIDE a variant (add it to a Liquid `variant.id`
// exclusion or a `hidden_variants` list). The reverses below SHOW a variant
// (remove it from those same shapes). Every reverse is idempotent: a file that
// doesn't reference the variant is returned as `null`, so a caller can skip
// the commit.

/**
 * Remove `id` from a Liquid `variant.id ==`/`!=` expression the forward
 * patcher composed.
 *
 *   `variant.id == A or variant.id == ID`     → `variant.id == A`
 *   `variant.id == ID or variant.id == B`     → `variant.id == B`
 *   `variant.id == ID`                        → whole comparison removed
 *   `variant.id != A and variant.id != ID`    → `variant.id != A`
 *
 * Whole-token guard matches the forward patcher so a longer numeric that
 * contains `id` as a substring is NOT touched.
 */
export function unpatchLiquidVariantExclusion(content: string, id: string): string | null {
  if (!id) return null;
  if (!content.includes(id)) return null;
  // Match `variant.id ==` OR `variant.id !=` optionally preceded by ` or `/` and ` (the
  // conjunction the forward patcher appended). Also strip a trailing ` or …`/` and …`
  // when the target is the FIRST term.
  const trailingEq = new RegExp(`\\s+or\\s+variant\\.id\\s*==\\s*${id}(?![0-9])`, "g");
  const trailingNe = new RegExp(`\\s+and\\s+variant\\.id\\s*!=\\s*${id}(?![0-9])`, "g");
  const leadingEq = new RegExp(`variant\\.id\\s*==\\s*${id}(?![0-9])\\s+or\\s+`, "g");
  const leadingNe = new RegExp(`variant\\.id\\s*!=\\s*${id}(?![0-9])\\s+and\\s+`, "g");
  // Solo comparison (no conjunction) — remove the whole `variant.id … ID` clause.
  const soloEq = new RegExp(`variant\\.id\\s*==\\s*${id}(?![0-9])`, "g");
  const soloNe = new RegExp(`variant\\.id\\s*!=\\s*${id}(?![0-9])`, "g");
  let out = content;
  out = out.replace(trailingEq, "");
  out = out.replace(trailingNe, "");
  out = out.replace(leadingEq, "");
  out = out.replace(leadingNe, "");
  out = out.replace(soloEq, "");
  out = out.replace(soloNe, "");
  return out === content ? null : out;
}

/**
 * Remove `id` from a JSON array or bare CSV shape the forward `patchJsonForSl`
 * composed. Handles `"ID"` (JSON array entry, optionally with a leading or
 * trailing comma) and bare-token CSV.
 */
export function unpatchJsonForVariant(content: string, id: string): string | null {
  if (!id) return null;
  if (!content.includes(id)) return null;
  let out = content;
  // JSON array entry with comma on either side.
  out = out.replaceAll(`,"${id}"`, "");
  out = out.replaceAll(`"${id}",`, "");
  out = out.replaceAll(`"${id}"`, "");
  // Bare CSV: strip with surrounding commas, then bare-token.
  const csvComma = new RegExp(`,\\s*${id}(?=[\\s,\\]"']|$)`, "g");
  out = out.replace(csvComma, "");
  const bare = new RegExp(`(^|[\\s\\[])${id}(?=[\\s,\\]"']|$),?`, "g");
  out = out.replace(bare, "$1");
  return out === content ? null : out;
}

/**
 * Remove `id` from every `"hidden_variants": "…"` CSV setting in the theme
 * settings JSON — the mirror of `patchHiddenVariantsSetting`.
 */
export function unpatchHiddenVariantsSetting(content: string, id: string): string | null {
  if (!id) return null;
  let changed = false;
  const out = content.replace(/("hidden_variants"\s*:\s*")([^"]*)(")/g, (_, head: string, csv: string, tail: string) => {
    const parts = csv.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.includes(id)) return `${head}${csv}${tail}`;
    changed = true;
    const nextCsv = parts.filter((p) => p !== id).join(",");
    return `${head}${nextCsv}${tail}`;
  });
  return changed ? out : null;
}
