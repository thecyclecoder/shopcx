import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Inside ShopCX",
};

export default function ShowcaseIndex() {
  return (
    <div className="sc-shell" style={{ padding: "64px 24px 0" }}>
      <div className="sc-narrow">
        <div className="sc-eyebrow">Inside ShopCX</div>
        <h1 className="sc-h1" style={{ margin: "16px 0 20px" }}>
          A retention operating system that builds itself.
        </h1>
        <p className="sc-lede">
          ShopCX is the system of record for keeping customers — support, subscriptions,
          returns, lifecycle, and storefront, unified on one platform. What makes it unusual
          isn&apos;t the surface area. It&apos;s how it gets built.
        </p>
        <p className="sc-lede" style={{ marginTop: 14 }}>
          Below are guided walkthroughs of the systems behind ShopCX, written for a curious
          outsider. No dashboards, no live data — just the ideas, drawn clearly.
        </p>
      </div>

      <hr className="sc-hr" />

      <div className="sc-eyebrow" style={{ marginBottom: 16 }}>Categories</div>
      <div className="sc-card-grid">
        <Link href="/showcase/autonomy" className="sc-card">
          <div className="sc-card-kicker">01 · Autonomy</div>
          <div className="sc-card-title">The autonomous organization</div>
          <p className="sc-card-desc">
            How AI &quot;directors&quot; run whole functions on their own — and how a human stays
            in command of the objectives, not the keystrokes. Start with the autonomous CTO.
          </p>
          <div className="sc-card-arrow">Explore →</div>
        </Link>

        {/* Future categories slot in here as sibling cards:
            Growth, Customer Experience, Finance — each a /showcase/{category}. */}
        <div className="sc-card" style={{ opacity: 0.6, boxShadow: "none" }}>
          <div className="sc-card-kicker">Soon</div>
          <div className="sc-card-title">More writeups</div>
          <p className="sc-card-desc">
            Additional system explainers will appear here as they&apos;re published.
          </p>
        </div>
      </div>

      <footer className="sc-footer sc-shell" style={{ paddingLeft: 0, paddingRight: 0 }}>
        <span>shopcx.ai · private preview</span>
        <span>read-only · no live data</span>
      </footer>
    </div>
  );
}
