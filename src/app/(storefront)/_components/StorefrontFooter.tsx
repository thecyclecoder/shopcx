/**
 * Storefront footer — policies + copyright, on every PDP (added in render-page).
 * Trust/legitimacy signal: clear legal links + contact + copyright line.
 *
 * Every policy now renders on this storefront (/policies/{slug}) from our own
 * `policies` table — including Privacy + Terms, migrated off Shopify so the
 * footer survives the Shopify sunset.
 */
interface Props {
  workspaceName: string;
  supportEmail: string | null;
}

const POLICY_LINKS: { label: string; href: string }[] = [
  { label: "Privacy Policy", href: "/policies/privacy" },
  { label: "Terms & Conditions", href: "/policies/terms" },
  { label: "Subscriptions Policy", href: "/policies/subscriptions" },
  { label: "Shipping & Returns", href: "/policies/returns" },
  { label: "Refunds", href: "/policies/refunds" },
  { label: "Exchanges", href: "/policies/exchanges" },
];

export function StorefrontFooter({ workspaceName, supportEmail }: Props) {
  const year = new Date().getFullYear();
  return (
    <footer className="w-full border-t border-zinc-200 bg-white py-10">
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          {POLICY_LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-900"
            >
              {l.label}
            </a>
          ))}
        </nav>

        {supportEmail && (
          <p className="mt-5 text-center text-sm text-zinc-500">
            Questions? Email us at{" "}
            <a href={`mailto:${supportEmail}`} className="font-medium text-zinc-700 hover:text-zinc-900">
              {supportEmail}
            </a>
          </p>
        )}

        <p className="mt-5 text-center text-xs text-zinc-400">
          © {year} {workspaceName}. All rights reserved. · Family-run in Austin, Texas 🤠
        </p>
      </div>
    </footer>
  );
}
