/**
 * Shared [[wikilink]] → dashboard-link preprocessor for the roadmap surfaces (board, spec/goal/
 * function detail). Resolves a brain-relative wikilink to its live dashboard route so the rendered
 * markdown navigates the Function → (Mandate | Goal) → Spec tree. Anything we can't route (a
 * lifecycle/table page) collapses to its alias/label text. See docs/brain/specs/goal-decomposition-engine.md.
 */
export interface WikilinkTargets {
  specSlugs?: string[];
  goalSlugs?: string[];
  functionSlugs?: string[];
}

/** [[../goals/x|alias]] / [[winning-static-creative-finder]] → a markdown link if it's a known spec/goal/function, else plain text. */
export function preprocessBrainWikilinks(md: string, t: WikilinkTargets): string {
  const specs = new Set(t.specSlugs ?? []);
  const goals = new Set(t.goalSlugs ?? []);
  const fns = new Set(t.functionSlugs ?? []);
  return md.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const [targetRaw, alias] = inner.split("|");
    const target = targetRaw.trim();
    const base = target.replace(/^.*\//, "").replace(/\.md$/, "");
    const label = (alias || base).trim();
    // Disambiguate by the path segment when present (…/goals/x vs …/functions/x vs …/specs/x).
    if (/(^|\/)goals\//.test(target) && goals.has(base)) return `[${label}](/dashboard/roadmap/goals/${base})`;
    if (/(^|\/)functions\//.test(target) && fns.has(base)) return `[${label}](/dashboard/roadmap/functions/${base})`;
    if (/(^|\/)specs\//.test(target) && specs.has(base)) return `[${label}](/dashboard/roadmap/${base})`;
    // Bare slug (no folder) — try spec, then goal, then function.
    if (!/\//.test(target)) {
      if (specs.has(base)) return `[${label}](/dashboard/roadmap/${base})`;
      if (goals.has(base)) return `[${label}](/dashboard/roadmap/goals/${base})`;
      if (fns.has(base)) return `[${label}](/dashboard/roadmap/functions/${base})`;
    }
    return label;
  });
}
