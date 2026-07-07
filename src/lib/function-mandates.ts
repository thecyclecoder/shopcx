/**
 * function-mandates — resolve a function's mandates from `docs/brain/functions/{slug}.md`.
 *
 * Phase 1 of improve-tab-spec-author-auto-anchors-bare-function-parent-to-mandate: the deterministic
 * resolver the [[author-spec]] chokepoint's Phase 2 bare-function-parent auto-anchor calls. Given a
 * function slug it returns the mandates declared under `## Mandates` — each `### heading` becomes a
 * mandate with:
 *
 *   - `slug` — the anchor used in `parentRef` (`{function}#{mandate-slug}`). Preferred source is an
 *     explicit `{#slug}` Markdown-Extra anchor on the heading (`### Autonomous build platform {#build}`),
 *     which lets a mandate pin a short, stable slug independent of its heading text. Fallback is a
 *     kebab-case of the heading (`Store tech / Shopify` → `store-tech-shopify`,
 *     `Infra & DevOps / reliability` → `infra-devops-reliability`).
 *   - `heading` — the heading text (annotation stripped) — surfaced to the Improve tab so a human sees
 *     which mandate was anchored.
 *   - `body` — the prose between this `### heading` and the next `###` or `##`, used by the best-fit
 *     term-overlap chooser when a bare function parent has more than one mandate to anchor to.
 *
 * Deterministic, no LLM. A missing file / empty `## Mandates` section returns [] (Phase 2 keeps the
 * `InvalidParentError` throw when a function has zero mandates — nothing to anchor to).
 */
import { promises as fs } from "fs";
import path from "path";

const FUNCTIONS_DIR = path.join(process.cwd(), "docs", "brain", "functions");

export interface FunctionMandate {
  /** Anchor slug: explicit `{#slug}` when the heading declares one, else kebab-case of the heading. */
  slug: string;
  /** Heading text as it renders (annotation stripped). */
  heading: string;
  /** Prose lines under the heading up to the next `###` / `##`, joined + trimmed. */
  body: string;
}

/** Standard kebab-case: lowercase, non-alphanumeric runs → single dash, trim leading/trailing dashes. */
function kebabize(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Parse a `### heading {#optional-slug}` line into `{ heading, slug }`. Falls back to kebabize when the
 *  explicit `{#…}` anchor is absent. Returns null when the line isn't an H3 heading. */
function parseMandateHeading(line: string): { heading: string; slug: string } | null {
  const h = line.match(/^###\s+(.+?)\s*$/);
  if (!h) return null;
  const anchor = h[1].match(/^(.*?)\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/i);
  if (anchor) {
    return { heading: anchor[1].trim(), slug: anchor[2].toLowerCase() };
  }
  return { heading: h[1].trim(), slug: kebabize(h[1]) };
}

/** Walk `## Mandates` and split it into per-mandate `{ heading, slug, body }` records. The section runs
 *  from the `## Mandates` line to the next `## ` heading (or EOF). Inside, each `### heading` opens a
 *  mandate; its body is every non-heading line up to the next `###` or `##`. */
export function parseFunctionMandates(raw: string): FunctionMandate[] {
  const lines = raw.split("\n");
  // Find the `## Mandates` section start (allow trailing " (perpetual)" etc).
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Mandates\b/i.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];
  // End at the next `## ` heading (or EOF).
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]) && !/^###/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const out: FunctionMandate[] = [];
  let cur: FunctionMandate | null = null;
  const bodyBuf: string[] = [];
  const flush = () => {
    if (!cur) return;
    cur.body = bodyBuf.join("\n").trim();
    out.push(cur);
    bodyBuf.length = 0;
  };
  for (let i = start; i < end; i++) {
    const l = lines[i];
    const parsed = parseMandateHeading(l);
    if (parsed) {
      flush();
      cur = { slug: parsed.slug, heading: parsed.heading, body: "" };
      continue;
    }
    if (cur) bodyBuf.push(l);
  }
  flush();
  return out;
}

/** Resolve the mandates declared on a function's charter doc. Returns [] for an unknown function slug
 *  (missing file) or a file with no `## Mandates` section. */
export async function resolveFunctionMandates(functionSlug: string): Promise<FunctionMandate[]> {
  const slug = (functionSlug || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) return [];
  const file = path.join(FUNCTIONS_DIR, `${slug}.md`);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  return parseFunctionMandates(raw);
}
