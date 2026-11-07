/**
 * Public / shared email providers — moved from fraud-detector.ts (engine Phase 1).
 *
 * Freemail, ISP, and disposable domains that *unrelated strangers legitimately
 * share*. Used as an EXCLUSION set: a domain here is NOT treated as a ring
 * signal. A *custom* domain (anything not here) reused against a confirmed-fraud
 * order, or spun up across many fresh accounts, is the real signal — rings
 * register fresh local parts on a throwaway domain they control (e.g.
 * @safelywater.com) to beat exact-email matching.
 *
 * Sourced from the `free-email-domains` list (~12.3k domains, includes legacy
 * providers like netscape.net that a hand-seeded set missed and that caused a
 * false-positive ring on 4 unrelated @netscape.net customers — see
 * docs/brain/lifecycles/fraud-detection.md). Vendored as JSON (no runtime dep);
 * refresh by re-downloading domains.json. The small inline supplement covers
 * anything the upstream list lacks.
 */
import freemailDomains from "./freemail-domains.json";

export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set<string>([
  ...(freemailDomains as string[]),
  // Supplement — keep additions the upstream list may miss:
  "netscape.com",
]);

/** Lowercased domain after the last "@", or "" when there is none. */
export function emailDomain(email: string | null | undefined): string {
  const e = (email || "").toLowerCase().trim();
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at + 1) : "";
}

/** A non-empty domain that is NOT a public/shared provider — one a ring could control. */
export function isCustomDomain(domain: string): boolean {
  return !!domain && !FREEMAIL_DOMAINS.has(domain);
}
