/**
 * email-typo — dependency-free detection + correction of mistyped email addresses.
 *
 * A customer who signs up as `dylanralston@gmaik.com` creates an account we can NEVER reach — every
 * reply, journey CTA, and magic link bounces into the void, and it silently spawns a duplicate of
 * their real account. This is the mailcheck algorithm (common-domain list + edit-distance on the
 * domain + TLD fixes), no external service, no network call. It only SUGGESTS — the caller (Sol,
 * confidence-gated) decides whether to auto-correct, confirm with the customer, or route to account
 * linking when the corrected address matches an existing account. See docs/brain (account linking).
 *
 * IMPORTANT: a suggestion is not permission to mutate. Sol NEVER "corrects" an address into one that
 * belongs to a DIFFERENT live customer except as a deliberate link (that would misroute their data).
 */

// The domains the overwhelming majority of consumers use. A domain that IS one of these is never
// "corrected". A domain CLOSE to one (edit distance 1-2) is a likely typo of it.
const COMMON_DOMAINS = [
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "live.com", "msn.com",
  "me.com", "mac.com", "ymail.com", "gmx.com", "protonmail.com", "proton.me",
  "yahoo.co.uk", "hotmail.co.uk", "outlook.co.uk", "googlemail.com",
];
const COMMON_SET = new Set(COMMON_DOMAINS);

// TLD typos we can fix deterministically (the second-level domain is fine, the TLD slipped).
const TLD_FIXES: Record<string, string> = {
  com: "com", con: "com", cmo: "com", comm: "com", ocm: "com", cm: "com", co: "com", vom: "com", xom: "com", clm: "com",
  net: "net", nte: "net", ne: "net", nett: "net",
  org: "org", ogr: "org", or: "org",
};

/** Damerau-ish Levenshtein (with transposition) — small strings, no allocation concerns. */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return d[m][n];
}

export type EmailTypoConfidence = "none" | "likely" | "high";

export interface EmailTypoSuggestion {
  /** the input, normalized (trimmed + lowercased) */
  normalized: string;
  /** the suggested correction (null when nothing to suggest) */
  corrected: string | null;
  /** did we find a plausible correction? */
  changed: boolean;
  /** high = single-edit toward a common domain (auto-correctable when corroborated); likely = 2 edits (confirm) */
  confidence: EmailTypoConfidence;
  /** what fired: 'exact_domain' | 'tld_fix' | 'domain_distance' | 'malformed' | 'none' */
  reason: string;
}

const NONE = (normalized: string, reason: string): EmailTypoSuggestion => ({
  normalized, corrected: null, changed: false, confidence: "none", reason,
});

/**
 * Suggest a correction for a possibly-mistyped email. Pure + deterministic. Returns confidence so the
 * caller can gate: `high` → auto-correct when corroborated (matches an existing account / order / name);
 * `likely` → confirm with the customer; `none` → leave it.
 */
export function suggestEmailCorrection(input: string): EmailTypoSuggestion {
  const normalized = String(input || "").trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return NONE(normalized, "malformed");
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!domain.includes(".")) return NONE(normalized, "malformed");
  if (COMMON_SET.has(domain)) return NONE(normalized, "exact_domain"); // already a known-good domain

  const dot = domain.lastIndexOf(".");
  const sld = domain.slice(0, dot);   // second-level, e.g. "gmail"
  const tld = domain.slice(dot + 1);  // top-level, e.g. "con"

  // 1) TLD-only fix: the SLD matches a common domain's SLD but the TLD is a known typo (gmail.con → gmail.com).
  if (TLD_FIXES[tld] && TLD_FIXES[tld] !== tld) {
    const fixedDomain = `${sld}.${TLD_FIXES[tld]}`;
    const corrected = `${local}@${fixedDomain}`;
    // High confidence only when the fixed domain is itself a common domain (gmail.con→gmail.com);
    // otherwise it's a generic TLD fix (mycompany.con→.com) — still likely, lower certainty.
    return {
      normalized, corrected, changed: true,
      confidence: COMMON_SET.has(fixedDomain) ? "high" : "likely",
      reason: "tld_fix",
    };
  }

  // 2) Whole-domain distance to a common domain (gmaik.com → gmail.com, gmial→gmail, yahooo→yahoo).
  let best: string | null = null;
  let bestDist = Infinity;
  for (const cand of COMMON_DOMAINS) {
    const dist = editDistance(domain, cand);
    if (dist < bestDist) { bestDist = dist; best = cand; }
  }
  // Guard against over-correcting a legitimate niche domain that merely looks similar: only fire when
  // the SLD is a near-miss (don't rewrite "gmailx.com" companies), and never rewrite domain→itself.
  if (best && best !== domain && bestDist <= 2) {
    // Extra guard: distance 2 is only trusted when the SLD length is long enough that 2 edits is still
    // a strong signal (avoids "aol.com"↔short-domain false positives).
    const confidence: EmailTypoConfidence = bestDist === 1 ? "high" : sld.length >= 5 ? "likely" : "none";
    if (confidence !== "none") {
      return { normalized, corrected: `${local}@${best}`, changed: true, confidence, reason: "domain_distance" };
    }
  }

  return NONE(normalized, "none");
}

/** Convenience: true when the address is plausibly mistyped (any non-'none' suggestion). */
export function looksMistyped(input: string): boolean {
  return suggestEmailCorrection(input).changed;
}
