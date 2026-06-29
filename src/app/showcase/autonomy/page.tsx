import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Autonomy",
};

export default function AutonomyIndex() {
  return (
    <div className="sc-shell" style={{ padding: "56px 24px 0" }}>
      <Link href="/showcase" className="sc-back" style={{ marginBottom: 24 }}>
        ← Showcase
      </Link>

      <div className="sc-narrow">
        <div className="sc-eyebrow">Category · Autonomy</div>
        <h1 className="sc-h1" style={{ margin: "16px 0 20px" }}>
          The autonomous organization
        </h1>
        <p className="sc-lede">
          ShopCX is run by a layer of AI &quot;directors,&quot; each owning a real function the way a
          VP would. They operate almost entirely on their own and surface only the genuinely
          serious decisions to the human in charge. These writeups go function by function.
        </p>
      </div>

      <hr className="sc-hr" />

      <div className="sc-eyebrow" style={{ marginBottom: 16 }}>Directors</div>
      <div className="sc-card-grid">
        <Link href="/showcase/autonomy/cto" className="sc-card">
          <div className="sc-card-kicker">Platform · DevOps</div>
          <div className="sc-card-title">The Autonomous CTO</div>
          <p className="sc-card-desc">
            Takes a feature from review to shipped-and-documented with no human on the routine
            path. Coordinates a fleet of specialized agents that plan, build, test, secure,
            merge, and document — and watches production to roll back its own bad deploys.
          </p>
          <div className="sc-card-arrow">Read the walkthrough →</div>
        </Link>

        {/* Future director writeups slot in here as siblings:
            /showcase/autonomy/growth, /showcase/autonomy/cx, etc. */}
        <div className="sc-card" style={{ opacity: 0.6, boxShadow: "none" }}>
          <div className="sc-card-kicker">Soon</div>
          <div className="sc-card-title">Growth · CX · Finance</div>
          <p className="sc-card-desc">
            Walkthroughs of the other directors are on the way.
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
