/**
 * Email-domain and surname velocity evaluators — the threshold decisions from
 * fraud-detector.ts checkVelocitySignals, factored out pure (engine Phase 1).
 * The caller loads the last VELOCITY_WINDOW_DAYS of rows and persists the case;
 * these decide whether it fires and word the title/summary.
 */
import { emailDomain, isCustomDomain } from "./freemail";

export const DOMAIN_MIN_CUSTOMERS = 4; // ≥4 distinct accounts on one custom domain
export const SURNAME_MIN_CUSTOMERS = 4; // ≥4 new accounts sharing a surname…
export const SURNAME_MIN_CUSTOM_DOMAIN = 2; // …with ≥2 on non-freemail domains
/** Surnames shorter than this are too common/ambiguous to group on. */
export const SURNAME_MIN_LENGTH = 3;

export type DomainVelocityResult = {
  fired: boolean;
  customerCount: number;
  emailCount: number;
  emails: string[]; // distinct, lowercased
  title: string;
  summary: string;
};

/** Many distinct accounts ordering on one custom (non-freemail) domain. A
 *  freemail domain never fires (the 2026-06-18 @netscape.net false positive). */
export function evaluateDomainVelocity(
  domain: string,
  rows: { customerId: string | null; email: string | null }[],
): DomainVelocityResult {
  const custs = new Set(rows.map((r) => r.customerId).filter(Boolean) as string[]);
  const emails = new Set(rows.map((r) => (r.email || "").toLowerCase()).filter(Boolean));
  const fired = isCustomDomain(domain) && custs.size >= DOMAIN_MIN_CUSTOMERS && emails.size >= DOMAIN_MIN_CUSTOMERS;
  return {
    fired,
    customerCount: custs.size,
    emailCount: emails.size,
    emails: [...emails],
    title: `${custs.size} accounts on @${domain} ordered in 30d`,
    summary: `${custs.size} distinct customers on the custom domain @${domain} placed orders in the last 30 days (${emails.size} distinct addresses) — characteristic of a ring spinning up throwaway accounts on one domain it controls.`,
  };
}

export type SurnameVelocityResult = {
  fired: boolean;
  customerCount: number;
  nonFreemailCount: number;
  title: string;
  summary: string;
};

/** Many new accounts sharing one surname, enough of them on custom domains.
 *  `rows` are the window's new customers whose last name matches `lastName`. */
export function evaluateSurnameVelocity(lastName: string, rows: { email: string | null }[]): SurnameVelocityResult {
  const name = lastName.trim();
  const nonFree = rows.filter((r) => isCustomDomain(emailDomain(r.email)));
  const fired =
    name.length >= SURNAME_MIN_LENGTH && rows.length >= SURNAME_MIN_CUSTOMERS && nonFree.length >= SURNAME_MIN_CUSTOM_DOMAIN;
  return {
    fired,
    customerCount: rows.length,
    nonFreemailCount: nonFree.length,
    title: `${rows.length} new "${name}" accounts (${nonFree.length} on custom domains, 30d)`,
    summary: `${rows.length} new accounts share the surname "${name}" in the last 30 days, ${nonFree.length} on custom (non-freemail) domains — characteristic of a ring reusing one identity across throwaway emails.`,
  };
}
