import type { Metadata } from "next";
import Link from "next/link";
import "./showcase.css";
import { ThemeToggle } from "./ThemeToggle";

export const metadata: Metadata = {
  title: {
    default: "ShopCX Showcase",
    template: "%s · ShopCX Showcase",
  },
  description:
    "A guided look inside ShopCX — the retention operating system and the autonomous engineering organization that builds it.",
  robots: { index: false, follow: false },
};

// Pre-paint theme resolution: read the saved choice, else the OS preference,
// and set `.showcase-dark` on the root BEFORE first paint so there's no flash.
const THEME_BOOTSTRAP = `(function(){try{var k=localStorage.getItem('showcase-theme');var d=k?k==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(d){document.currentScript.parentElement.classList.add('showcase-dark');}}catch(e){}})();`;

export default function ShowcaseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="showcase-root">
      {/* Runs inside .showcase-root, before children paint. */}
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />

      <header className="sc-topbar">
        <div className="sc-shell sc-topbar-inner">
          <Link href="/showcase" className="sc-brand">
            <span className="sc-brand-mark">CX</span>
            <span>
              ShopCX <span className="sc-brand-sub">Showcase</span>
            </span>
          </Link>
          <div className="sc-topbar-actions">
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main>{children}</main>
    </div>
  );
}
