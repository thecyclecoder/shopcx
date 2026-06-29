// Inline SVG diagrams for the Autonomous CTO walkthrough. All vector, no image
// deps; every color is a CSS token (sc-svg-* classes) so they adapt to theme.
// Pure presentational server components.

function Box({
  x,
  y,
  w,
  h,
  title,
  sub,
  variant = "elev",
  stroke = "",
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  variant?: "elev" | "sunken";
  stroke?: "accent" | "good" | "warn" | "";
}) {
  const strokeClass =
    stroke === "accent"
      ? "sc-svg-stroke-accent"
      : stroke === "good"
      ? "sc-svg-stroke-good"
      : stroke === "warn"
      ? "sc-svg-stroke-warn"
      : "sc-svg-stroke";
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={10}
        className={`${variant === "elev" ? "sc-svg-fill-elev" : "sc-svg-fill-sunken"} ${strokeClass}`}
        strokeWidth={1.5}
      />
      <text
        x={x + w / 2}
        y={sub ? y + h / 2 - 4 : y + h / 2 + 4}
        textAnchor="middle"
        className="sc-svg-text"
        fontSize={13}
        fontWeight={600}
      >
        {title}
      </text>
      {sub ? (
        <text
          x={x + w / 2}
          y={y + h / 2 + 13}
          textAnchor="middle"
          className="sc-svg-text-muted sc-svg-mono"
          fontSize={10.5}
        >
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function ArrowDefs() {
  return (
    <defs>
      <marker id="sc-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
        <path d="M1,1 L8,4.5 L1,8" fill="none" className="sc-svg-stroke" strokeWidth={1.5} />
      </marker>
      <marker id="sc-arrow-accent" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
        <path d="M1,1 L8,4.5 L1,8" fill="none" className="sc-svg-stroke-accent" strokeWidth={1.6} />
      </marker>
      <marker id="sc-arrow-good" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
        <path d="M1,1 L8,4.5 L1,8" fill="none" className="sc-svg-stroke-good" strokeWidth={1.6} />
      </marker>
      <marker id="sc-arrow-warn" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
        <path d="M1,1 L8,4.5 L1,8" fill="none" className="sc-svg-stroke-warn" strokeWidth={1.6} />
      </marker>
    </defs>
  );
}

/* ── Section 1 — DB (in-flight) → ship → fold → brain (permanent) ── */
export function DiagramFold() {
  return (
    <svg viewBox="0 0 720 230" role="img" aria-label="In-flight work in the database folds into the permanent brain when it ships">
      <ArrowDefs />
      {/* DB cluster */}
      <text x={130} y={28} textAnchor="middle" className="sc-svg-text-accent sc-svg-mono" fontSize={11} letterSpacing="1.5">
        DATABASE — WORK IN FLIGHT
      </text>
      <Box x={30} y={44} w={200} h={150} title="" variant="sunken" />
      <Box x={50} y={64} w={160} h={34} title="Spec" sub="phases ▸ derived status" stroke="accent" />
      <Box x={50} y={108} w={160} h={34} title="Goal" sub="milestones rollup" stroke="accent" />
      <Box x={50} y={152} w={160} h={30} title="Build phases" sub="one per commit" />

      {/* ship + fold */}
      <line x1={232} y1={119} x2={300} y2={119} className="sc-svg-stroke-good" strokeWidth={1.6} markerEnd="url(#sc-arrow-good)" />
      <text x={266} y={108} textAnchor="middle" className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        ships
      </text>
      <Box x={302} y={96} w={96} h={46} title="fold" sub="event-driven" variant="elev" stroke="good" />
      <line x1={400} y1={119} x2={468} y2={119} className="sc-svg-stroke-good" strokeWidth={1.6} markerEnd="url(#sc-arrow-good)" />
      <text x={434} y={108} textAnchor="middle" className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        then delete
      </text>

      {/* brain cluster */}
      <text x={590} y={28} textAnchor="middle" className="sc-svg-text-accent sc-svg-mono" fontSize={11} letterSpacing="1.5">
        BRAIN — PERMANENT
      </text>
      <Box x={470} y={44} w={230} h={150} title="" variant="sunken" />
      <Box x={488} y={62} w={92} h={30} title="tables" />
      <Box x={590} y={62} w={92} h={30} title="libraries" />
      <Box x={488} y={100} w={92} h={30} title="pipelines" />
      <Box x={590} y={100} w={92} h={30} title="journeys" />
      <Box x={488} y={138} w={194} h={40} title="one page per system part" sub="deduplicated knowledge" />
    </svg>
  );
}

/* ── Section 2 — phase commits → spec branch → PR + gates → merge → fold ── */
export function DiagramPipeline() {
  return (
    <svg viewBox="0 0 760 300" role="img" aria-label="Phases accumulate on a spec branch, then a PR runs spec-test and security before an atomic merge to main">
      <ArrowDefs />
      {/* commits */}
      <text x={90} y={26} textAnchor="middle" className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        one phase / commit
      </text>
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <circle cx={40 + i * 50} cy={60} r={9} className="sc-svg-fill-elev sc-svg-stroke-accent" strokeWidth={1.6} />
          {i < 2 ? (
            <line x1={49 + i * 50} y1={60} x2={81 + i * 50} y2={60} className="sc-svg-stroke" strokeWidth={1.4} />
          ) : null}
        </g>
      ))}
      <line x1={149} y1={60} x2={205} y2={60} className="sc-svg-stroke" strokeWidth={1.4} markerEnd="url(#sc-arrow)" />
      <Box x={206} y={40} w={170} h={40} title="spec branch" sub="claude/build-{slug}" stroke="accent" />
      <text x={291} y={102} textAnchor="middle" className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        accumulate — no PR yet
      </text>
      <text x={291} y={116} textAnchor="middle" className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        (preview deploy is tested)
      </text>

      <line x1={376} y1={60} x2={430} y2={60} className="sc-svg-stroke-accent" strokeWidth={1.6} markerEnd="url(#sc-arrow-accent)" />
      <text x={403} y={50} textAnchor="middle" className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        complete
      </text>
      <Box x={432} y={40} w={90} h={40} title="open PR" stroke="accent" />

      {/* gates */}
      <line x1={477} y1={80} x2={477} y2={120} className="sc-svg-stroke" strokeWidth={1.4} markerEnd="url(#sc-arrow)" />
      <Box x={388} y={122} w={178} h={38} title="AI spec-test" sub="graded vs checklist" stroke="good" />
      <Box x={388} y={166} w={178} h={38} title="security review" sub="every diff" stroke="good" />
      <text x={477} y={224} textAnchor="middle" className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        both green
      </text>

      <line x1={566} y1={183} x2={628} y2={183} className="sc-svg-stroke-good" strokeWidth={1.6} markerEnd="url(#sc-arrow-good)" />
      <Box x={630} y={150} w={110} h={66} title="squash → main" sub="atomic" stroke="good" />
      <line x1={685} y1={150} x2={685} y2={110} className="sc-svg-stroke-good" strokeWidth={1.4} markerEnd="url(#sc-arrow-good)" />
      <Box x={630} y={70} w={110} h={38} title="shipped → fold" stroke="good" />

      {/* goal-branch variant */}
      <line x1={45} y1={230} x2={715} y2={230} className="sc-svg-stroke" strokeWidth={1} strokeDasharray="3 4" />
      <text x={40} y={256} className="sc-svg-text-accent sc-svg-mono" fontSize={10.5} letterSpacing="1">
        GOAL VARIANT
      </text>
      <text x={40} y={276} className="sc-svg-text-muted" fontSize={11.5}>
        many specs accumulate on a shared
      </text>
      <text x={40} y={291} className="sc-svg-text-muted sc-svg-mono" fontSize={11}>
        goal/&#123;slug&#125;
      </text>
      <text x={232} y={276} className="sc-svg-text-muted" fontSize={11.5}>
        → the whole goal promotes to main in one atomic release.
      </text>
      <text x={232} y={291} className="sc-svg-text-muted" fontSize={11.5}>
        A one-off spec merges straight to main.
      </text>
    </svg>
  );
}

/* ── Section 3 — CEO → Director → Tool, escalate up / grade down ── */
export function DiagramSupervision() {
  return (
    <svg viewBox="0 0 620 300" role="img" aria-label="CEO supervises Director supervises Tool, with escalate-up and grade-down arrows">
      <ArrowDefs />
      <Box x={210} y={20} w={200} h={52} title="CEO (human)" sub="owns company objectives" stroke="accent" />
      <Box x={210} y={124} w={200} h={52} title="Director (role agent)" sub="owns the objective · ~99% autonomous" stroke="accent" />
      <Box x={210} y={228} w={200} h={52} title="Tool" sub="optimizes a bounded proxy" />

      {/* down = grade (left side) */}
      <line x1={270} y1={72} x2={270} y2={124} className="sc-svg-stroke-good" strokeWidth={1.6} markerEnd="url(#sc-arrow-good)" />
      <line x1={270} y1={176} x2={270} y2={228} className="sc-svg-stroke-good" strokeWidth={1.6} markerEnd="url(#sc-arrow-good)" />
      <text x={150} y={104} textAnchor="middle" className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        grades ↓
      </text>
      <text x={150} y={208} textAnchor="middle" className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        grades ↓
      </text>

      {/* up = escalate (right side) */}
      <line x1={350} y1={228} x2={350} y2={176} className="sc-svg-stroke-warn" strokeWidth={1.6} markerEnd="url(#sc-arrow-warn)" />
      <line x1={350} y1={124} x2={350} y2={72} className="sc-svg-stroke-warn" strokeWidth={1.6} markerEnd="url(#sc-arrow-warn)" />
      <text x={470} y={208} textAnchor="middle" className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        ↑ hit a rail? escalate
      </text>
      <text x={470} y={104} textAnchor="middle" className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        ↑ serious? escalate
      </text>
    </svg>
  );
}

/* ── Section 4 — the agent fleet around the pipeline with checkpoints ── */
export function DiagramFleet() {
  return (
    <svg viewBox="0 0 760 320" role="img" aria-label="The autonomous CTO coordinates a fleet of agents around the build pipeline with approval and gate checkpoints">
      <ArrowDefs />
      <Box x={280} y={16} w={200} h={48} title="Autonomous CTO" sub="Platform / DevOps Director" stroke="accent" />

      {/* pipeline lane */}
      {[
        { x: 20, t: "Planner", s: "decompose" },
        { x: 168, t: "Spec-reviewer", s: "gate: well-formed?" },
        { x: 316, t: "Builder", s: "writes code" },
        { x: 464, t: "Spec-tester", s: "AI grader" },
        { x: 612, t: "Security", s: "reviews diff" },
      ].map((n, i, arr) => (
        <g key={n.t}>
          <Box x={n.x} y={120} w={128} h={50} title={n.t} sub={n.s} stroke={n.t === "Spec-reviewer" || n.t === "Spec-tester" || n.t === "Security" ? "good" : ""} />
          {i < arr.length - 1 ? (
            <line x1={n.x + 128} y1={145} x2={arr[i + 1].x} y2={145} className="sc-svg-stroke" strokeWidth={1.4} markerEnd="url(#sc-arrow)" />
          ) : null}
          {/* CTO coordinates each */}
          <line x1={380} y1={64} x2={n.x + 64} y2={120} className="sc-svg-stroke-accent" strokeWidth={0.8} strokeDasharray="2 4" />
        </g>
      ))}

      {/* merge + post-merge */}
      <line x1={676} y1={170} x2={676} y2={206} className="sc-svg-stroke-good" strokeWidth={1.5} markerEnd="url(#sc-arrow-good)" />
      <Box x={612} y={208} w={128} h={46} title="atomic merge" sub="both gates green" stroke="good" />
      <line x1={612} y1={231} x2={470} y2={231} className="sc-svg-stroke-good" strokeWidth={1.5} markerEnd="url(#sc-arrow-good)" />
      <Box x={316} y={208} w={150} h={46} title="Fold agent" sub="writes the docs" stroke="good" />
      <line x1={316} y1={231} x2={258} y2={231} className="sc-svg-stroke" strokeWidth={1.4} markerEnd="url(#sc-arrow)" />
      <Box x={130} y={208} w={124} h={46} title="Deploy guardian" sub="auto-rollback" stroke="warn" />

      {/* checkpoints */}
      <text x={40} y={290} className="sc-svg-text-accent sc-svg-mono" fontSize={10.5} letterSpacing="1">
        CHECKPOINTS
      </text>
      <text x={40} y={308} className="sc-svg-text-muted" fontSize={11}>
        review-before-build · spec-test + security before merge · migrations need explicit approval · bad deploy reverts itself · every approval &amp; grade audited
      </text>
    </svg>
  );
}

/* ── The engine — server → foreman → lane pool ← job queue ← specs,
      the 3 Max accounts feeding the lanes, and the self-update loop ── */
export function DiagramEngine() {
  return (
    <svg viewBox="0 0 760 360" role="img" aria-label="One server runs a foreman supervising a pool of worker lanes that claim jobs from a queue fed by specs, drawing on three Claude Max accounts, with a self-update loop">
      <ArrowDefs />

      {/* specs → queue */}
      <Box x={20} y={150} w={110} h={48} title="specs" sub="the roadmap" stroke="accent" />
      <line x1={130} y1={174} x2={176} y2={174} className="sc-svg-stroke-accent" strokeWidth={1.5} markerEnd="url(#sc-arrow-accent)" />
      <Box x={178} y={150} w={120} h={48} title="job queue" sub="25 job kinds" />
      <line x1={298} y1={174} x2={344} y2={174} className="sc-svg-stroke" strokeWidth={1.5} markerEnd="url(#sc-arrow)" />

      {/* the server box wraps foreman + lanes */}
      <rect x={346} y={28} width={394} height={300} rx={12} className="sc-svg-fill-sunken sc-svg-stroke" strokeWidth={1.5} />
      <text x={362} y={50} className="sc-svg-text-accent sc-svg-mono" fontSize={11} letterSpacing="1.5">
        ONE SERVER (you could SSH in)
      </text>

      <Box x={364} y={62} w={150} h={44} title="foreman" sub="supervises lanes" stroke="accent" />
      {/* foreman polls/dispatches to lanes */}
      <line x1={439} y1={106} x2={439} y2={132} className="sc-svg-stroke" strokeWidth={1.4} markerEnd="url(#sc-arrow)" />
      <text x={344} y={174} textAnchor="end" className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        claim ↺ every few sec
      </text>

      {/* lane pool */}
      <text x={364} y={128} className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        worker lanes
      </text>
      {/* 8 build lanes */}
      {Array.from({ length: 8 }).map((_, i) => (
        <rect
          key={`b${i}`}
          x={364 + i * 22}
          y={134}
          width={16}
          height={40}
          rx={4}
          className="sc-svg-fill-elev sc-svg-stroke-accent"
          strokeWidth={1.3}
        />
      ))}
      <text x={364} y={190} className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        8 build lanes
      </text>

      {/* specialized lanes row */}
      {["test×3", "sec", "review", "fold", "migr", "repair", "deploy"].map((t, i) => (
        <g key={t}>
          <rect x={364 + i * 53} y={206} width={48} height={34} rx={5} className="sc-svg-fill-elev sc-svg-stroke" strokeWidth={1.2} />
          <text x={364 + i * 53 + 24} y={227} textAnchor="middle" className="sc-svg-text-muted sc-svg-mono" fontSize={9}>
            {t}
          </text>
        </g>
      ))}
      <text x={364} y={256} className="sc-svg-text-muted sc-svg-mono" fontSize={10}>
        ~17 specialized lanes
      </text>

      {/* 3 Max accounts feeding the lanes */}
      <Box x={364} y={272} w={250} h={42} title="3 Claude Max accounts" sub="the labor pool · capacity-aware" stroke="warn" />
      <line x1={489} y1={272} x2={489} y2={246} className="sc-svg-stroke-warn" strokeWidth={1.3} markerEnd="url(#sc-arrow-warn)" />
      <text x={628} y={296} className="sc-svg-text-muted sc-svg-mono" fontSize={9.5}>
        busy → queue,
      </text>
      <text x={628} y={308} className="sc-svg-text-muted sc-svg-mono" fontSize={9.5}>
        never oversubscribe
      </text>

      {/* self-update loop */}
      <line x1={690} y1={62} x2={690} y2={132} className="sc-svg-stroke-good" strokeWidth={1.5} markerEnd="url(#sc-arrow-good)" />
      <Box x={620} y={62} w={108} h={44} title="ship → main" sub="pull + restart" stroke="good" />
      <path d="M 620 84 C 560 84 560 40 540 40" fill="none" className="sc-svg-stroke-good" strokeWidth={1.4} markerEnd="url(#sc-arrow-good)" />
      <text x={548} y={26} className="sc-svg-text-muted sc-svg-mono" fontSize={9.5}>
        rebuilds its own machinery ↻
      </text>
    </svg>
  );
}
