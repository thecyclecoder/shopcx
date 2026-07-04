// Showcase → Teardowns → example board (docs/brain/specs/research-teardowns-view.md, Phase 2).
// SERVER-render the founder-approved teardown HTML board for one research_urls row —
//   (a) masthead with source url + brand + strategy + a stat strip
//   (b) funnel-beat ribbon from the recipe's `architecture`
//   (c) 9-lever inventory from the recipe's `levers` (tag + evidence)
//   (d) chapter walk — every chapter's signed screenshot next to its analysis
//   (e) mono build skeleton from `transferable_pattern` (component tags + a repeat marker)
// Teal accent (Rhea's), analysis layer in mono, narrative in serif; inherits the Showcase
// light+dark theming via .showcase-root CSS variables. Password-gated by src/proxy.ts.
// Read-only; a missing `capture_ref` still renders the recipe board without shots.

import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getResearchUrlById,
  listResearchShotChapters,
  type ResearchUrl,
  type TeardownRecipe,
} from "@/lib/research-urls";

const TEAL = "#0d9488"; // Rhea's accent — used only where the shared showcase indigo would fight the brief.
const TEAL_SOFT = "rgba(13, 148, 136, 0.10)";
const TEAL_BORDER = "rgba(13, 148, 136, 0.35)";

function shortHost(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}
function pathOf(u: string): string {
  try {
    const p = new URL(u).pathname;
    return p === "/" ? "" : p;
  } catch {
    return "";
  }
}

function StatChip({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "10px 14px",
        borderRadius: 10,
        border: "1px solid var(--sc-border)",
        background: "var(--sc-bg-elev)",
        minWidth: 84,
      }}
    >
      <span
        className="sc-mono"
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          fontSize: 10.5,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--sc-fg-faint)",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 18,
          fontWeight: 650,
          color: "var(--sc-fg)",
          marginTop: 2,
          fontFamily: "var(--sc-mono)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Masthead({ row, recipe, chapterCount }: { row: ResearchUrl; recipe: TeardownRecipe; chapterCount: number }) {
  const reasonCount = recipe.reason_sequence?.length ?? 0;
  return (
    <header style={{ marginBottom: 32 }}>
      <div className="sc-eyebrow" style={{ color: TEAL }}>
        Rhea · Teardown board
      </div>
      <h1
        className="sc-h1"
        style={{
          fontFamily: 'ui-serif, Georgia, "Times New Roman", serif',
          margin: "12px 0 10px",
        }}
      >
        {row.brand || shortHost(row.url)}
      </h1>
      <a
        href={row.url}
        target="_blank"
        rel="noreferrer noopener"
        className="sc-mono"
        style={{
          display: "inline-block",
          background: "transparent",
          border: "none",
          padding: 0,
          fontSize: 13,
          color: "var(--sc-fg-muted)",
          textDecoration: "none",
        }}
      >
        {shortHost(row.url)}
        {pathOf(row.url)}
      </a>
      <p
        className="sc-lede"
        style={{
          fontFamily: 'ui-serif, Georgia, "Times New Roman", serif',
          margin: "18px 0 22px",
          maxWidth: 760,
        }}
      >
        {recipe.strategy}
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <StatChip label="Funnel" value={recipe.funnel_type} />
        <StatChip label="Chapters" value={chapterCount || recipe.architecture.length} />
        <StatChip label="Reasons" value={reasonCount} />
        <StatChip label="Levers" value={recipe.levers.length} />
        <StatChip label="Offer options" value={recipe.offer.options} />
      </div>
    </header>
  );
}

function Ribbon({ architecture }: { architecture: TeardownRecipe["architecture"] }) {
  if (architecture.length === 0) return null;
  return (
    <section style={{ margin: "32px 0" }}>
      <div className="sc-eyebrow" style={{ color: TEAL, marginBottom: 12 }}>
        Funnel-beat ribbon
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: 6,
          overflowX: "auto",
          padding: 12,
          borderRadius: 12,
          border: "1px solid var(--sc-border)",
          background: "var(--sc-bg-sunken)",
        }}
      >
        {architecture.map((a, i) => (
          <div key={`${a.chapter_role}-${i}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div
              style={{
                minWidth: 140,
                padding: "8px 12px",
                borderRadius: 8,
                background: "var(--sc-bg-elev)",
                border: `1px solid ${TEAL_BORDER}`,
              }}
            >
              <div
                className="sc-mono"
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  fontSize: 10.5,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: TEAL,
                }}
              >
                beat {i + 1}
              </div>
              <div
                style={{
                  marginTop: 3,
                  fontFamily: "var(--sc-mono)",
                  fontSize: 13,
                  color: "var(--sc-fg)",
                  fontWeight: 600,
                }}
              >
                {a.chapter_role}
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: "var(--sc-fg-muted)", lineHeight: 1.4 }}>
                {a.purpose}
              </div>
            </div>
            {i < architecture.length - 1 && (
              <span style={{ color: "var(--sc-fg-faint)", fontFamily: "var(--sc-mono)" }}>→</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function LeverInventory({ levers }: { levers: TeardownRecipe["levers"] }) {
  if (levers.length === 0) return null;
  return (
    <section style={{ margin: "40px 0" }}>
      <div className="sc-eyebrow" style={{ color: TEAL, marginBottom: 12 }}>
        Lever inventory ({levers.length})
      </div>
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        }}
      >
        {levers.map((l, i) => (
          <div
            key={`${l.lever}-${i}`}
            style={{
              padding: 14,
              borderRadius: 12,
              border: "1px solid var(--sc-border)",
              background: "var(--sc-bg-elev)",
            }}
          >
            <span
              className="sc-mono"
              style={{
                display: "inline-block",
                background: TEAL_SOFT,
                border: `1px solid ${TEAL_BORDER}`,
                color: TEAL,
                padding: "3px 8px",
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {l.lever}
            </span>
            <div
              style={{
                marginTop: 10,
                fontSize: 13.5,
                color: "var(--sc-fg)",
                lineHeight: 1.5,
              }}
            >
              {l.evidence}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface ChapterEntry {
  index: number;
  label: string;
  signed_url: string | null;
}

function ChapterWalk({
  chapters,
  recipe,
}: {
  chapters: ChapterEntry[];
  recipe: TeardownRecipe;
}) {
  const arch = recipe.architecture;
  const reasons = recipe.reason_sequence ?? [];
  // Chapter list to iterate: real chapters when captured; otherwise fall back to the architecture
  // roles so the recipe board still renders gracefully with no shots.
  const rows: Array<ChapterEntry & { roleIndex: number }> =
    chapters.length > 0
      ? chapters.map((c, i) => ({ ...c, roleIndex: i }))
      : arch.map((_, i) => ({ index: i, label: `chapter-${i}`, signed_url: null, roleIndex: i }));

  if (rows.length === 0) return null;

  return (
    <section style={{ margin: "40px 0" }}>
      <div className="sc-eyebrow" style={{ color: TEAL, marginBottom: 12 }}>
        Chapter walk
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {rows.map((row) => {
          const role = arch[row.roleIndex];
          const reason = reasons[row.roleIndex];
          return (
            <div
              key={row.index}
              style={{
                display: "grid",
                gap: 20,
                gridTemplateColumns: "minmax(160px, 220px) 1fr",
                padding: 16,
                borderRadius: 12,
                border: "1px solid var(--sc-border)",
                background: "var(--sc-bg-elev)",
                alignItems: "start",
              }}
            >
              <div>
                <div
                  className="sc-mono"
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    fontSize: 10.5,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: TEAL,
                    marginBottom: 6,
                  }}
                >
                  chapter {row.index}
                </div>
                {row.signed_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={row.signed_url}
                    alt={role?.chapter_role ?? row.label}
                    loading="lazy"
                    style={{
                      width: "100%",
                      display: "block",
                      borderRadius: 8,
                      border: "1px solid var(--sc-border)",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      aspectRatio: "9 / 16",
                      display: "grid",
                      placeItems: "center",
                      borderRadius: 8,
                      border: "1px dashed var(--sc-border-strong)",
                      background: "var(--sc-bg-sunken)",
                      color: "var(--sc-fg-faint)",
                      fontFamily: "var(--sc-mono)",
                      fontSize: 12,
                      padding: 12,
                      textAlign: "center",
                    }}
                  >
                    no capture
                  </div>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {role && (
                  <div>
                    <div
                      style={{
                        fontFamily: "var(--sc-mono)",
                        fontSize: 13,
                        color: "var(--sc-fg)",
                        fontWeight: 700,
                      }}
                    >
                      {role.chapter_role}
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        fontFamily: 'ui-serif, Georgia, "Times New Roman", serif',
                        fontSize: 15,
                        color: "var(--sc-fg-muted)",
                        lineHeight: 1.55,
                      }}
                    >
                      {role.purpose}
                    </div>
                  </div>
                )}
                {reason && (
                  <div
                    style={{
                      padding: 12,
                      borderRadius: 10,
                      background: "var(--sc-bg-sunken)",
                      border: "1px solid var(--sc-border)",
                    }}
                  >
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                      <span
                        className="sc-mono"
                        style={{
                          background: reason.appeal === "emotion" ? "rgba(236, 72, 153, 0.12)" : TEAL_SOFT,
                          border: `1px solid ${reason.appeal === "emotion" ? "rgba(236, 72, 153, 0.35)" : TEAL_BORDER}`,
                          color: reason.appeal === "emotion" ? "#db2777" : TEAL,
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 600,
                        }}
                      >
                        {reason.appeal}
                      </span>
                      <span
                        className="sc-mono"
                        style={{
                          background: "var(--sc-bg-elev)",
                          border: "1px solid var(--sc-border)",
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          color: "var(--sc-fg-muted)",
                        }}
                      >
                        reason {reason.order}
                      </span>
                    </div>
                    <div
                      style={{
                        fontFamily: 'ui-serif, Georgia, "Times New Roman", serif',
                        fontSize: 15,
                        color: "var(--sc-fg)",
                        fontWeight: 600,
                      }}
                    >
                      {reason.benefit}
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 13,
                        color: "var(--sc-fg-muted)",
                        lineHeight: 1.55,
                      }}
                    >
                      {reason.mechanism}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function OfferPanel({ offer }: { offer: TeardownRecipe["offer"] }) {
  const rows: Array<{ label: string; value: string | number }> = [];
  if (offer.discount) rows.push({ label: "discount", value: offer.discount });
  if (offer.bundle) rows.push({ label: "bundle", value: offer.bundle });
  if (offer.guarantee) rows.push({ label: "guarantee", value: offer.guarantee });
  if (offer.urgency) rows.push({ label: "urgency", value: offer.urgency });
  rows.push({ label: "options", value: offer.options });
  return (
    <section style={{ margin: "40px 0" }}>
      <div className="sc-eyebrow" style={{ color: TEAL, marginBottom: 12 }}>
        Offer anatomy
      </div>
      <div
        style={{
          padding: 20,
          borderRadius: 12,
          border: "1px solid var(--sc-border)",
          background: "var(--sc-bg-elev)",
          display: "grid",
          gap: 12,
        }}
      >
        {rows.map((r) => (
          <div
            key={r.label}
            style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 12, alignItems: "baseline" }}
          >
            <span
              className="sc-mono"
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--sc-fg-faint)",
              }}
            >
              {r.label}
            </span>
            <span
              style={{
                fontFamily: 'ui-serif, Georgia, "Times New Roman", serif',
                fontSize: 15,
                color: "var(--sc-fg)",
              }}
            >
              {String(r.value)}
            </span>
          </div>
        ))}
        {(offer.bonuses ?? []).length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 12, alignItems: "baseline" }}>
            <span
              className="sc-mono"
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--sc-fg-faint)",
              }}
            >
              bonuses
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(offer.bonuses ?? []).map((b, i) => (
                <span
                  key={`${b}-${i}`}
                  className="sc-mono"
                  style={{
                    background: TEAL_SOFT,
                    border: `1px solid ${TEAL_BORDER}`,
                    color: TEAL,
                    padding: "3px 8px",
                    borderRadius: 999,
                    fontSize: 11.5,
                  }}
                >
                  {b}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function BuildSkeleton({ recipe }: { recipe: TeardownRecipe }) {
  // The transferable pattern is prose (a string); we render it in mono. Then we tag each architecture
  // role as a component and mark any 'reason' role as a repeat unit (a listicle's repeatable beat).
  const arch = recipe.architecture;
  return (
    <section style={{ margin: "40px 0" }}>
      <div className="sc-eyebrow" style={{ color: TEAL, marginBottom: 12 }}>
        Build skeleton (transferable pattern)
      </div>
      <div
        style={{
          padding: 20,
          borderRadius: 12,
          border: "1px solid var(--sc-border)",
          background: "var(--sc-bg-sunken)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <pre
          style={{
            fontFamily: "var(--sc-mono)",
            fontSize: 13,
            lineHeight: 1.65,
            color: "var(--sc-fg)",
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {recipe.transferable_pattern}
        </pre>
        {arch.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {arch.map((a, i) => {
              const isRepeat = /reason|beat|item/i.test(a.chapter_role);
              return (
                <span
                  key={`${a.chapter_role}-${i}`}
                  className="sc-mono"
                  style={{
                    background: isRepeat ? TEAL_SOFT : "var(--sc-bg-elev)",
                    border: `1px solid ${isRepeat ? TEAL_BORDER : "var(--sc-border)"}`,
                    color: isRepeat ? TEAL : "var(--sc-fg-muted)",
                    padding: "3px 8px",
                    borderRadius: 6,
                    fontSize: 11.5,
                    fontWeight: isRepeat ? 600 : 500,
                  }}
                  title={isRepeat ? "repeat unit" : "component"}
                >
                  {a.chapter_role}
                  {isRepeat ? " × N" : ""}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export default async function TeardownExampleShowcasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const row = await getResearchUrlById(id);
  if (!row || !row.teardown) notFound();
  const recipe = row.teardown;
  const chapters = await listResearchShotChapters(row.capture_ref);

  return (
    <div className="sc-shell" style={{ padding: "40px 24px 80px" }}>
      <Link href="/dashboard/research/teardowns" className="sc-back" style={{ marginBottom: 20 }}>
        ← Teardowns
      </Link>
      <Masthead row={row} recipe={recipe} chapterCount={chapters.length} />
      <Ribbon architecture={recipe.architecture} />
      <LeverInventory levers={recipe.levers} />
      <ChapterWalk
        chapters={chapters.map((c) => ({ index: c.index, label: c.label, signed_url: c.signed_url }))}
        recipe={recipe}
      />
      <OfferPanel offer={recipe.offer} />
      <BuildSkeleton recipe={recipe} />
      <div className="sc-footer" style={{ borderTop: "1px solid var(--sc-border)" }}>
        <span>Board rendered from the research_urls row&apos;s TeardownRecipe.</span>
        <span>capture_ref · {row.capture_ref ?? "—"}</span>
      </div>
    </div>
  );
}
