/**
 * brain-ref-suggest — author-time SUGGESTER for the `**Brain refs:**` line spec Phase 2 introduced
 * ([[../specs/spec-brain-refs]]). At authoring time we scan the spec body for the src/ files, tables,
 * and existing brain wikilinks it names, resolve each to a docs/brain/{libraries|inngest|tables|
 * lifecycles|integrations}/{name}.md that ACTUALLY exists on disk, and propose the top 2-4 as the
 * `**Brain refs:**` line the author can accept/edit. Phase 1 taught the build-spec skill to Read the
 * line FIRST as the authoritative brain slice for the build; Phase 2 makes that line cheap to author.
 *
 * The suggestion is a BEST-EFFORT proposal, not an override — if the spec body already carries a
 * `**Brain refs:**` line, the author-picked refs win (never clobber). If nothing maps, we suggest none
 * (no error). Everything is fs-verified against the current `docs/brain/` tree so a wikilink to a
 * missing page never survives (a broken ref would point the builder AT the wrong slice, exactly what
 * the spec's "never an auto-inject that could point the builder at the wrong slice" invariant guards).
 *
 * Pure module — no DB, no network. `deriveSuggestedBrainRefs` returns the resolved wikilink targets
 * (relative to `docs/brain/specs/`, e.g. `../libraries/foo`) and `injectSuggestedBrainRefsLine` splices
 * the `**Brain refs:**` line into a spec body just below the last metadata header line.
 */
import { existsSync } from "fs";
import { join } from "path";

/** Where to root the brain existence check. Defaults to the repo's `docs/brain/`. */
function defaultBrainDir(): string {
  return join(process.cwd(), "docs", "brain");
}

/** True when the body already carries a `**Brain refs:** …` metadata line (any surrounding whitespace).
 *  Line-anchored so a prose mention of the phrase inside a paragraph is NOT a false positive. */
export function hasBrainRefsLine(body: string): boolean {
  return /^\s*\*\*Brain refs:\*\*/im.test(body);
}

/**
 * fix-spec-brain-refs — the durable, persisted "author explicitly skipped Brain refs" marker. An
 * HTML comment because it survives re-authoring (part of the body) yet renders as nothing on GitHub /
 * the dashboard, so an author-picked skip doesn't leave a visible artifact in the spec text. Paired
 * with the second signal `hasBrainRefsSkip` also recognizes — a header line whose value is empty
 * (`**Brain refs:**` on its own, no wikilinks) — a Refine that clears the injected refs without
 * removing the header is likewise durable.
 *
 * Why a persisted signal is required: `hasBrainRefsLine` already treats ANY `**Brain refs:** …` line
 * as "author picked, never clobber" — but if a refine REMOVES the line entirely (the natural "I don't
 * want brain refs on this spec" edit), the next authoring re-scans + re-injects it. Without a
 * durable marker, the suggester has no way to distinguish a brand-new spec from one where the author
 * explicitly said "skip." This marker is that distinction.
 */
export const BRAIN_REFS_SKIP_MARKER = "<!-- brain-refs: skip -->";

/** True when the body carries the durable skip marker — the `<!-- brain-refs: skip -->` HTML comment.
 *  Case-insensitive + whitespace-tolerant so an author-typed variant still matches. */
export function hasBrainRefsSkipMarker(body: string): boolean {
  return /<!--\s*brain-refs\s*:\s*skip\s*-->/i.test(body);
}

/**
 * True when the body carries EITHER durable skip signal — an empty `**Brain refs:**` header (author
 * kept the header but cleared the value) OR the `<!-- brain-refs: skip -->` HTML comment (an
 * invisible durable marker). Both are equivalent: "author explicitly picked NONE — do not re-inject."
 * The empty-header form was implicitly supported by `hasBrainRefsLine`; this helper makes the intent
 * explicit for callers that also want to no-op on the comment marker.
 */
export function hasBrainRefsSkip(body: string): boolean {
  if (hasBrainRefsSkipMarker(body)) return true;
  // An empty `**Brain refs:**` header line — the header exists but carries no wikilinks after it.
  // Line-anchored + tolerant of trailing whitespace so `**Brain refs:**   ` still counts as skip.
  if (/^\s*\*\*Brain refs:\*\*\s*$/im.test(body)) return true;
  return false;
}

/** A resolved candidate ref: the target wikilink relative to `docs/brain/specs/` (e.g. `../libraries/foo`)
 *  + the on-disk `docs/brain/…` path we verified exists. */
export interface BrainRefCandidate {
  /** Wikilink target as it would appear in `[[…]]`, relative to `docs/brain/specs/`. */
  wikilink: string;
  /** Absolute-ish path (from `brainDir`'s parent) to the verified brain page. */
  path: string;
}

/**
 * Scan a spec body for the src/files, tables, and wikilinks it names, and return the top N candidate
 * brain pages (default 4) — each verified to exist under `brainDir`. The order is stable: existing
 * wikilinks first (the author already pointed at these), then src/lib matches, then table matches. Deduped
 * by wikilink target. Never throws — a scan miss returns [].
 */
export function deriveSuggestedBrainRefs(
  body: string,
  brainDir: string = defaultBrainDir(),
  max: number = 4,
): BrainRefCandidate[] {
  const seen = new Set<string>();
  const out: BrainRefCandidate[] = [];

  const push = (wikilink: string, path: string): void => {
    if (seen.has(wikilink)) return;
    if (out.length >= max) return;
    seen.add(wikilink);
    out.push({ wikilink, path });
  };

  const tryDir = (
    kind: "libraries" | "inngest" | "tables" | "lifecycles" | "integrations" | "recipes" | "journeys" | "playbooks" | "dashboard",
    name: string,
  ): void => {
    if (!name) return;
    const rel = `${kind}/${name}.md`;
    const abs = join(brainDir, rel);
    if (existsSync(abs)) push(`../${kind}/${name}`, abs);
  };

  // 1) Existing wikilinks the author already dropped in the body — `[[../libraries/foo]]`,
  //    `[[../tables/foo]]`, etc. These are the author's own pointer and go first. Also accepts the
  //    kind-only form `[[libraries/foo]]` (some legacy specs) — normalize to `../libraries/foo`.
  //    SKIP wikilinks that appear on METADATA header lines (Owner / Parent / Blocked-by / Repair-of /
  //    Regression-of / Brain refs) — those aren't build refs, they're taxonomy. The Owner line's
  //    `[[../functions/{slug}]]` is the classic false positive this guard blocks.
  //    Only harvest build-relevant kinds — functions / goals are org-chart, not build context.
  const buildRelevantKinds = new Set([
    "libraries", "inngest", "tables", "lifecycles", "integrations", "recipes", "journeys", "playbooks", "dashboard",
  ]);
  const metadataLinePattern = /^\s*\*\*(Owner|Parent|Blocked-by|Repair-signature|Regression-of|Regression-signature|Brain refs):\*\*/i;
  for (const line of body.split("\n")) {
    if (metadataLinePattern.test(line)) continue;
    for (const m of line.matchAll(/\[\[(?:\.\.\/)?([a-z]+)\/([a-z0-9_\-]+)(?:\.md)?(?:\|[^\]]+)?\]\]/gi)) {
      const kind = m[1].toLowerCase();
      const name = m[2].toLowerCase();
      if (!buildRelevantKinds.has(kind)) continue;
      tryDir(kind as Parameters<typeof tryDir>[0], name);
    }
  }

  // 2) src/lib/inngest/{name}.ts → docs/brain/inngest/{name}.md (Inngest fn pages are basename-only).
  //    Matched before the general src/lib rule so an inngest file resolves to its inngest page, not
  //    a same-name libraries page (which usually doesn't exist for inngest handlers anyway).
  for (const m of body.matchAll(/\bsrc\/lib\/inngest\/([a-z0-9_\-]+)\.ts\b/gi)) {
    tryDir("inngest", m[1].toLowerCase());
  }

  // 3) src/lib/{anywhere}/{name}.ts OR src/lib/{name}.ts → docs/brain/libraries/{name}.md.
  //    Basename-only lookup (matches the observed brain convention — e.g. src/lib/agents/agent-grader.ts
  //    → docs/brain/libraries/agent-grader.md). Skip .test.ts (test files never have brain pages). Also
  //    skip src/lib/inngest/*.ts — rule 2 already routed it to the inngest page, and a same-basename
  //    libraries page is almost always a different concern (avoids duplicate refs like
  //    `[[../inngest/dunning]] · [[../libraries/dunning]]` burning two of the four slots on the same file).
  for (const m of body.matchAll(/\bsrc\/lib\/(?:([a-z0-9_\-]+)\/)?(?:[a-z0-9_\-]+\/)*([a-z0-9_\-]+)\.tsx?\b/gi)) {
    const firstDir = (m[1] ?? "").toLowerCase();
    if (firstDir === "inngest") continue;
    const name = m[2].toLowerCase();
    if (name.endsWith(".test") || name.endsWith(".spec")) continue;
    tryDir("libraries", name);
  }

  // 4) public.{table} references — Postgres table refs. Also match .from('{table}') supabase calls
  //    which name a table without the `public.` prefix.
  for (const m of body.matchAll(/\bpublic\.([a-z_][a-z0-9_]*)\b/gi)) {
    tryDir("tables", m[1].toLowerCase());
  }
  for (const m of body.matchAll(/\.from\(['"]([a-z_][a-z0-9_]*)['"]\)/gi)) {
    tryDir("tables", m[1].toLowerCase());
  }

  return out;
}

/** Format a resolved candidate list as the `**Brain refs:**` line body — `[[wikilink]] · [[wikilink]] · …`. */
export function formatBrainRefsLine(refs: BrainRefCandidate[]): string {
  if (!refs.length) return "";
  return `**Brain refs:** ${refs.map((r) => `[[${r.wikilink}]]`).join(" · ")}`;
}

/**
 * Inject a `**Brain refs:**` line into the spec body just below the LAST existing metadata header
 * (Owner / Parent / Blocked-by / Priority / Deferred / Auto-build / Repair-signature / Regression-of /
 * Regression-signature) so it sits in the same metadata block Phase 1's parser scans. No-op when:
 *   - refs is empty (nothing to propose),
 *   - the body already carries a `**Brain refs:**` line (the author already picked — never clobber),
 *   - no metadata line exists to anchor to (an unusual spec shape — skip rather than guess placement).
 *
 * Never throws — returns the original body when injection isn't safe.
 */
export function injectSuggestedBrainRefsLine(body: string, refs: BrainRefCandidate[]): string {
  if (!refs.length) return body;
  if (hasBrainRefsLine(body)) return body;
  // fix-spec-brain-refs — honor the durable skip marker. A body carrying `<!-- brain-refs: skip -->`
  // is an explicit "author picked none" signal; never re-inject over it, regardless of what maps.
  if (hasBrainRefsSkipMarker(body)) return body;

  const lines = body.split("\n");
  const isMetaLine = (l: string): boolean =>
    /^\s*\*\*(Owner|Parent|Blocked-by|Priority|Deferred|Auto-build|Repair-signature|Regression-of|Regression-signature):\*\*/i.test(l);

  let lastMeta = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isMetaLine(lines[i])) lastMeta = i;
  }
  if (lastMeta === -1) return body;

  const inject = formatBrainRefsLine(refs);
  const next = lines.slice(0, lastMeta + 1).concat(inject, lines.slice(lastMeta + 1));
  return next.join("\n");
}

/**
 * One-shot: derive suggestions from `body` and return a body with a `**Brain refs:**` line injected
 * (when safe + when we mapped ≥1 real page). The caller uses this at spec-authoring time as a
 * best-effort suggestion — the author picks/edits from there. Never throws; returns `body` unchanged
 * when the derive maps nothing, the body already carries a refs line, or an fs blip means we can't
 * verify. Returns `{ body, refs }` so the caller can log which refs were proposed.
 */
export function suggestBrainRefs(
  body: string,
  brainDir?: string,
): { body: string; refs: BrainRefCandidate[] } {
  try {
    if (hasBrainRefsLine(body)) return { body, refs: [] };
    // fix-spec-brain-refs — a durable skip marker (either the `<!-- brain-refs: skip -->` comment or
    // an empty `**Brain refs:**` header) means the author explicitly picked NONE. Short-circuit to
    // { body, refs:[] } so a subsequent re-author does NOT re-inject the previously-mapped ref.
    if (hasBrainRefsSkip(body)) return { body, refs: [] };
    const refs = deriveSuggestedBrainRefs(body, brainDir);
    if (!refs.length) return { body, refs };
    const next = injectSuggestedBrainRefsLine(body, refs);
    return { body: next, refs };
  } catch {
    return { body, refs: [] };
  }
}
