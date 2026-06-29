import type { Metadata } from "next";
import Link from "next/link";
import {
  DiagramFold,
  DiagramPipeline,
  DiagramEngine,
  DiagramSupervision,
  DiagramFleet,
} from "./diagrams";

export const metadata: Metadata = {
  title: "The Autonomous CTO",
  description:
    "How ShopCX takes a feature from review to shipped-and-documented with no human on the routine path — a self-building, self-testing, self-supervising engineering organization.",
};

const SECTIONS = [
  { id: "memory", n: "01", label: "The spec & the brain" },
  { id: "pipeline", n: "02", label: "The pipeline" },
  { id: "engine", n: "03", label: "The engine" },
  { id: "supervision", n: "04", label: "Supervision" },
  { id: "fleet", n: "05", label: "The agent fleet" },
];

export default function AutonomousCtoPage() {
  return (
    <div className="sc-shell" style={{ padding: "48px 24px 0" }}>
      <Link href="/showcase/autonomy" className="sc-back" style={{ marginBottom: 24 }}>
        ← Autonomy
      </Link>

      {/* Hero */}
      <header className="sc-narrow" style={{ marginBottom: 8 }}>
        <div className="sc-eyebrow">Platform · DevOps · the autonomous CTO</div>
        <h1 className="sc-h1" style={{ margin: "16px 0 20px" }}>
          An engineering organization that builds, tests, ships, and documents itself.
        </h1>
        <p className="sc-lede">
          Most companies hire engineers to write code and managers to decide what gets built.
          ShopCX inverts the routine: an AI platform director — an autonomous CTO — runs the
          engineering function, coordinating a fleet of specialized agents that take a feature
          from idea to live-in-production with no human on the normal path. A person still owns
          the objectives. They just don&apos;t own the keystrokes.
        </p>
        <div className="sc-pill-row" style={{ marginTop: 22 }}>
          <span className="sc-pill"><span className="sc-pill-dot" style={{ background: "var(--sc-accent)" }} />self-building</span>
          <span className="sc-pill"><span className="sc-pill-dot" style={{ background: "var(--sc-good)" }} />self-testing</span>
          <span className="sc-pill"><span className="sc-pill-dot" style={{ background: "var(--sc-accent-2)" }} />self-merging</span>
          <span className="sc-pill"><span className="sc-pill-dot" style={{ background: "var(--sc-warn)" }} />self-documenting</span>
          <span className="sc-pill"><span className="sc-pill-dot" style={{ background: "var(--sc-bad)" }} />self-supervising</span>
        </div>
      </header>

      <hr className="sc-hr" />

      <div className="sc-doc-layout">
        {/* TOC */}
        <nav className="sc-toc" aria-label="On this page">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              <span className="sc-toc-num">{s.n}</span>
              {s.label}
            </a>
          ))}
        </nav>

        <article className="sc-prose">
          {/* ─────────────── Section 1 ─────────────── */}
          <section id="memory" className="sc-section">
            <div className="sc-section-index">01</div>
            <h2 className="sc-h2">The database is the spec; the brain is the memory</h2>
            <p className="sc-muted" style={{ marginBottom: 20 }}>
              Two kinds of knowledge, cleanly separated — and never allowed to blur.
            </p>

            <p>
              <strong>Work in flight</strong> — the specs being planned, the goals in progress,
              their milestones and build phases — lives in the <strong>database</strong>. The
              database is the single source of truth for what&apos;s being built right now. We say
              it plainly: <span className="sc-mono">the database is the spec</span>. There is no
              second copy in a doc somewhere that can quietly fall out of date.
            </p>
            <p>
              A spec&apos;s status is never <em>stored</em>. It&apos;s <strong>derived</strong> from
              the rollup of its phases. If three of four build phases are done, the status reflects
              exactly that — computed, every time it&apos;s read. A stored status column would
              drift the moment reality moved without someone remembering to update it. A derived
              one can&apos;t lie, because there&apos;s nothing to forget to update.
            </p>

            <div className="sc-figure">
              <DiagramFold />
              <div className="sc-figcaption">in-flight (DB) → ship → fold → permanent (brain)</div>
            </div>

            <p>
              When a spec ships, its knowledge doesn&apos;t evaporate and it doesn&apos;t pile up.
              It <strong>folds</strong> into the <strong>brain</strong> — a structured map of the
              whole system, with one page per table, per library, per integration, per pipeline,
              per customer journey. The transient spec, having served its purpose, is deleted. So
              the split is clean: <strong>ephemeral work in the database, permanent deduplicated
              system-knowledge in the brain.</strong>
            </p>

            <div className="sc-callout">
              <strong>The invariant:</strong> code without a brain page is incomplete. Every
              feature lands its own documentation in the same change that ships it — not &quot;later,&quot;
              not in a backlog. Done means documented.
            </div>

            <p>
              The fold is <strong>event-driven</strong>: a spec folds the moment it ships, while
              the context is fresh. A periodic sweep runs as a backstop, so nothing can slip
              through if an event is ever missed. The result is a living encyclopedia of the system
              that is always current, never duplicated, and written as a byproduct of building —
              not as a chore bolted on afterward.
            </p>
          </section>

          {/* ─────────────── Section 2 ─────────────── */}
          <section id="pipeline" className="sc-section">
            <div className="sc-section-index">02</div>
            <h2 className="sc-h2">The pipeline: one branch per spec, atomic merge to main</h2>
            <p className="sc-muted" style={{ marginBottom: 20 }}>
              A roadmap board where every status is computed, and a merge that&apos;s all-or-nothing.
            </p>

            <p>
              The roadmap is a board with the familiar columns —{" "}
              <span className="sc-mono">Planned → Building → In&nbsp;Testing → Shipped</span> — but
              with one twist: nobody drags cards between them. Every column is{" "}
              <strong>derived from the underlying phase state</strong>, not hand-set. The board is
              a read-out of reality, not a thing someone has to keep tidy.
            </p>
            <p>
              A spec builds <strong>one phase per commit</strong> onto a single spec branch,{" "}
              <span className="sc-mono">claude/build-&#123;slug&#125;</span>, accumulating as it
              goes. Crucially, <strong>no pull request opens during this accumulation.</strong> The
              branch&apos;s own preview deployment is what gets exercised and tested — so work in
              progress is genuinely testable without prematurely asking &quot;is this ready to merge?&quot;
            </p>

            <div className="sc-figure">
              <DiagramPipeline />
              <div className="sc-figcaption">
                phase commits → spec branch (accumulate, no PR) → PR + spec-test + security → atomic merge → shipped → fold
              </div>
            </div>

            <p>
              Only when <strong>every phase is built</strong> — accumulation complete — does the PR
              open and two pre-merge gates run against the preview deployment: an{" "}
              <strong>AI spec-test</strong>, which grades the work against the spec&apos;s own
              verification checklist, and a <strong>security review</strong>. Both green is the only
              path forward. Then the branch is <strong>squash-merged to main, atomically</strong>,
              every phase flips to shipped, and the reactive fold (from section 1) fires.
            </p>

            <div className="sc-grid-2">
              <div className="sc-mini-card">
                <span className="sc-mini-tag">Goals</span>
                <h4>One atomic promotion</h4>
                <p>
                  For a multi-spec goal, each spec accumulates onto a shared goal branch
                  (<span className="sc-mono">goal/&#123;slug&#125;</span>), and the whole goal merges
                  to main in a single atomic promotion once it&apos;s complete. A one-off spec merges
                  straight to main. Nested goals release their children independently.
                </p>
              </div>
              <div className="sc-mini-card">
                <span className="sc-mini-tag">Resilience</span>
                <h4>Self-healing, not cron-fragile</h4>
                <p>
                  Every gate has a reactive primary trigger plus a standing-pass backstop. If an
                  event is ever missed, the backstop catches it on the next pass — so the pipeline
                  heals itself rather than silently stalling.
                </p>
              </div>
            </div>
          </section>

          {/* ─────────────── Section 3 ─────────────── */}
          <section id="engine" className="sc-section">
            <div className="sc-section-index">03</div>
            <h2 className="sc-h2">The engine: a self-updating factory on one server</h2>
            <p className="sc-muted" style={{ marginBottom: 20 }}>
              The abstract pipeline above runs somewhere real — here&apos;s the machine.
            </p>

            <p>
              Everything so far is a process, but processes run on hardware. This one runs on a{" "}
              <strong>single remote server</strong> — not anyone&apos;s laptop, not a CI runner that
              spins up and vanishes. A long-lived <strong>foreman</strong> process sits on that box
              and supervises a pool of <strong>worker lanes</strong>. Each lane polls a shared job
              queue every few seconds and claims the next piece of work it&apos;s qualified to do.
            </p>

            <div className="sc-figure">
              <DiagramEngine />
              <div className="sc-figcaption">
                specs → job queue → foreman → lane pool (8 build + ~17 specialized) · 3 Max accounts feed the lanes · ship→main→pull→restart
              </div>
            </div>

            <div className="sc-grid-2">
              <div className="sc-mini-card">
                <span className="sc-mini-tag">Parallelism</span>
                <h4>Many things at once</h4>
                <p>
                  Roughly <span className="sc-mono">8 build lanes</span> run features concurrently,
                  alongside ~17 specialized lanes — spec-test (×3), security review, spec-review,
                  fold, migration-fix, PR-conflict-resolve, repair, deploy-watch, and more
                  (<span className="sc-mono">25 job kinds</span> in total). The org builds, tests,
                  reviews, and ships many things in parallel — not one at a time.
                </p>
              </div>
              <div className="sc-mini-card">
                <span className="sc-mini-tag">Capacity</span>
                <h4>A bounded labor pool</h4>
                <p>
                  The lanes draw on a finite pool of{" "}
                  <span className="sc-mono">3 Claude Max accounts</span> — the &quot;engineers.&quot;
                  Scheduling is capacity-aware: when the pool is busy, work <em>queues</em> rather
                  than failing or oversubscribing.
                </p>
              </div>
            </div>

            <div className="sc-callout">
              <strong>The kicker — it rebuilds its own machinery.</strong> When the org ships an
              improvement to <span className="sc-mono">main</span>, the box fetches its <em>own</em>{" "}
              new code and restarts to run it. The engine that built the improvement is upgraded{" "}
              <em>by</em> that improvement — autonomously. We&apos;ve watched it self-update through a
              dozen of its own commits in a single session.
            </div>

            <p>
              The net of it: one server, a foreman, parallel lanes, and a bounded labor pool — a
              real, self-improving build factory. Not a metaphor. A machine you could SSH into.
            </p>
          </section>

          {/* ─────────────── Section 4 ─────────────── */}
          <section id="supervision" className="sc-section">
            <div className="sc-section-index">04</div>
            <h2 className="sc-h2">Supervision: bounded tools, accountable owners</h2>
            <p className="sc-muted" style={{ marginBottom: 20 }}>
              The founding principle — and the reason the autonomy doesn&apos;t go off the rails.
            </p>

            <p>
              Every autonomous tool optimizes a <strong>bounded proxy</strong> — some measurable
              stand-in for what we actually want. And any proxy, pushed hard enough, can reach a
              degenerate state that destroys the real objective. That&apos;s{" "}
              <strong>Goodhart&apos;s law</strong>: when a measure becomes a target, it stops being
              a good measure. A system that only ever chases its proxy will, eventually, find a way
              to win the metric while losing the point.
            </p>
            <p>
              So the architecture is layered on purpose: <strong>a tool optimizes a bounded proxy →
              a role-agent (a &quot;director&quot;) owns the actual objective and supervises the
              tool → the CEO owns the company objectives.</strong> Each layer answers to the one
              above it for the thing that layer can&apos;t see on its own.
            </p>

            <div className="sc-figure">
              <DiagramSupervision />
              <div className="sc-figcaption">CEO → Director → Tool · escalate up (rails) · grade down (coaching)</div>
            </div>

            <p>
              The rule that holds it together: hitting a guardrail means{" "}
              <strong>escalate, not execute</strong>. A tool never silently pushes past its rail to
              keep its metric climbing — reaching the edge of its authority is itself the signal to
              hand the decision up. Supervision is routed <strong>structurally, by ownership</strong>:
              every spec declares an owner function, and decisions route up the org chart. If the
              owning director is live and trusted, it auto-decides within its &quot;leash&quot;;
              otherwise it escalates to the human CEO.
            </p>

            <div className="sc-callout">
              <strong>Fail-safe by construction:</strong> nothing acts unsupervised. A director runs
              roughly <span className="sc-mono">99%</span> autonomously and escalates only the
              genuinely serious. If supervision is ever unavailable, the default is to escalate —
              never to proceed.
            </div>

            <p>
              And the loop closes: every decision is logged and graded in a{" "}
              <strong>coaching cascade</strong>. The CEO grades the director; the director grades the
              worker. Grades flow down as coaching, escalations flow up as accountability — so the
              system doesn&apos;t just act autonomously, it gets <em>better</em> at acting
              autonomously, with a human shaping the standard.
            </p>
          </section>

          {/* ─────────────── Section 5 ─────────────── */}
          <section id="fleet" className="sc-section">
            <div className="sc-section-index">05</div>
            <h2 className="sc-h2">The autonomous CTO and the agent fleet</h2>
            <p className="sc-muted" style={{ marginBottom: 20 }}>
              Where it all comes together: a director and the specialists it commands.
            </p>

            <p>
              The <strong>autonomous CTO</strong> — an AI platform director — takes a feature from
              review all the way to shipped-and-documented with no human on the routine path,
              surfacing to the CEO only the super-serious calls. It doesn&apos;t do everything
              itself; it <strong>coordinates a fleet of specialized agents</strong>, each owning a
              stage of the work.
            </p>

            <div className="sc-figure">
              <DiagramFleet />
              <div className="sc-figcaption">the agent fleet around the pipeline, with the approval &amp; gate checkpoints marked</div>
            </div>

            <div className="sc-grid-2">
              <div className="sc-mini-card"><span className="sc-mini-tag">Plan</span><h4>Planner</h4><p>Decomposes a goal into specs and phases that can actually be built.</p></div>
              <div className="sc-mini-card"><span className="sc-mini-tag">Build</span><h4>Builder</h4><p>Writes the code, one phase per commit, onto the spec branch.</p></div>
              <div className="sc-mini-card"><span className="sc-mini-tag">Gate</span><h4>Spec-reviewer</h4><p>Won&apos;t let a malformed spec enter the build pipeline at all.</p></div>
              <div className="sc-mini-card"><span className="sc-mini-tag">Gate</span><h4>Spec-tester</h4><p>An AI grader that scores the result against the spec&apos;s checklist.</p></div>
              <div className="sc-mini-card"><span className="sc-mini-tag">Gate</span><h4>Security guardian</h4><p>Reviews every diff before it can merge — no exceptions.</p></div>
              <div className="sc-mini-card"><span className="sc-mini-tag">Document</span><h4>Fold agent</h4><p>Writes the permanent brain pages the moment the work ships.</p></div>
              <div className="sc-mini-card"><span className="sc-mini-tag">Operate</span><h4>Deploy guardian</h4><p>Watches production and auto-rolls-back a deploy-correlated regression, then escalates.</p></div>
              <div className="sc-mini-card"><span className="sc-mini-tag">Coordinate</span><h4>The CTO</h4><p>Routes work between them, decides within its leash, escalates the rest.</p></div>
            </div>

            <h3 style={{ fontSize: "1.05rem", fontWeight: 640, margin: "28px 0 10px" }}>The checks and balances</h3>
            <p>
              Autonomy without brakes is just a faster way to break things, so the pipeline is full
              of them. A spec must pass review <strong>before it can build</strong>. Both the
              spec-test and the security review must be green <strong>before any merge</strong>.
              Database migrations require an <strong>explicit approval</strong> — the director&apos;s
              or the CEO&apos;s — because schema changes are the one move that&apos;s genuinely hard to
              undo. A bad deploy <strong>reverts itself</strong>. And the whole thing is{" "}
              <strong>audited</strong>: every approval and every grade is recorded.
            </p>

            <div className="sc-callout">
              <strong>The net result:</strong> a self-building, self-testing, self-merging,
              self-documenting, self-supervising engineering organization — with a human owning the
              objectives, not the keystrokes.
            </div>
          </section>

          <footer className="sc-footer">
            <span>shopcx.ai · the autonomous CTO</span>
            <Link href="/showcase/autonomy" className="sc-back">← back to Autonomy</Link>
          </footer>
        </article>
      </div>
    </div>
  );
}
