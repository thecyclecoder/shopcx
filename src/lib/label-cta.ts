/**
 * Return-label CTA rendering — the single source of truth for turning a
 * prepaid-return-label URL into a clickable button instead of a raw S3 link.
 *
 * Two entry points:
 *   - ctaButton(url, label): the styled button markup (table-based for Outlook
 *     compat; also works in the chat widget's dangerouslySetInnerHTML).
 *   - renderLabelUrlsAsButtons(html): a safety-net sweep over a finished
 *     outbound message that converts any BARE EasyPost label URL (one the AI
 *     pasted as plain text, not inside an href) into a button.
 *
 * Why the safety net: the {{label_url}} placeholder path only handles a single
 * label and only when the AI uses the token. When the AI free-texts label URLs
 * — e.g. re-delivering existing labels, or after the single-token path breaks —
 * customers got long literal "https://easypost-files.s3..." strings in the body
 * (Traci Studebaker, ticket 1b62b00f, 2026-06-19). This sink-level sweep makes
 * "raw label URL in a customer message" impossible regardless of code path.
 */

export function ctaButton(url: string, label: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 16px 0;"><tr><td bgcolor="#0f766e" style="background-color:#0f766e;border-radius:8px;"><a href="${url}" style="display:inline-block;padding:14px 24px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">${label}</a></td></tr></table>`;
}

// Bare EasyPost label URL NOT already inside an href/attribute. The negative
// lookbehind skips URLs preceded by " ' or = (i.e. href="…" / href='…' /
// href=…), so a properly-rendered CTA button (ctaButton emits a quoted href)
// is never double-wrapped. `>` is deliberately NOT in the lookbehind: a
// button's URL only ever sits inside a quoted href, never right after a bare
// `>`, so excluding `>` protected nothing and instead skipped legitimate
// body-text URLs that happen to sit alone in a `<p>…</p>` (ticket a00b0c22).
const BARE_LABEL_URL_RE = /(?<!["'=])https?:\/\/easypost-files\.s3[^\s"'<>]+/gi;

export function renderLabelUrlsAsButtons(html: string): string {
  if (!html || !BARE_LABEL_URL_RE.test(html)) return html;
  return html.replace(BARE_LABEL_URL_RE, (url) => {
    // Trim trailing sentence punctuation the AI may have appended.
    const clean = url.replace(/[.,;:)\]]+$/, "");
    return ctaButton(clean, "Download your prepaid return label →");
  });
}
