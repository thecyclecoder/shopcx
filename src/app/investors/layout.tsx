import type { Metadata } from "next";
import "./investors.css";

export const metadata: Metadata = {
  title: {
    default: "Superfoods · Investor Update",
    template: "%s · Superfoods Investors",
  },
  description: "A private monthly look at how Superfoods Company is performing.",
  robots: { index: false, follow: false },
};

// Pre-paint theme resolution — respect the OS preference before first paint so
// there's no light/dark flash. Charts (CfoFinancials) key off .dark / data-theme.
const THEME_BOOTSTRAP = `(function(){try{if(window.matchMedia('(prefers-color-scheme: dark)').matches){document.currentScript.parentElement.classList.add('dark');}}catch(e){}})();`;

export default function InvestorsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="inv-root">
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      <header className="inv-topbar">
        <div className="inv-shell inv-topbar-inner">
          <span className="inv-brand">
            <span className="inv-brand-mark">S</span>
            <span>Superfoods <span className="inv-brand-sub">Investor Update</span></span>
          </span>
          <span className="inv-private">Private</span>
        </div>
      </header>
      <main className="inv-shell">{children}</main>
      <footer className="inv-shell inv-footer">
        Private &amp; confidential — prepared for Superfoods Company investors and owners. Figures are sourced from our accounting system for fully-closed months.
      </footer>
    </div>
  );
}
