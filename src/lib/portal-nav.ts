/**
 * Portal client-side navigation helper.
 *
 * The customer portal is a custom-domain mini-site: `proxy.ts` middleware
 * rewrites `/portal/{slug}/*` → `/*` ONLY on the customer-facing host, so on
 * that domain every internal path is root-relative ("/", "/logout", …). On
 * localhost and path-based `shopcx.ai/portal/{slug}` there is NO rewrite — the
 * portal lives under `/portal/{slug}`. A root-relative link like "/logout"
 * therefore escapes the portal there and hits the ADMIN app (which bounces an
 * unauthenticated visitor to its own /login).
 *
 * `portalHref` keeps the `/portal/{slug}` prefix when the rewrite isn't in
 * play (detected from the current path) and stays prefix-free on the custom
 * domain. Call it for HARD navigations (window.location / anchor clicks); the
 * SPA's in-session section nav uses history.pushState and doesn't need it.
 */
export function portalHref(path: string): string {
  if (typeof window === "undefined") return path;
  const m = window.location.pathname.match(/^\/portal\/([^/]+)/);
  if (!m) return path; // custom domain — already prefix-free
  const base = `/portal/${m[1]}`;
  return path === "/" ? base : `${base}${path}`;
}
