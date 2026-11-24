/**
 * Minimal Markdown → HTML converter for policy pages. Intentionally limited
 * to the subset we use in customer_summary:
 *   • # H1 / ## H2 / ### H3
 *   • paragraphs separated by blank lines
 *   • **bold**, *italic*
 *   • [text](url) links
 *   • - or * bullet lists
 *
 * Output is bare semantic HTML; the look lives in `legal.css` (scoped under
 * `.lp-body`). Every H2 gets a stable `id` so the page's "On this page"
 * table of contents can link to it — `renderPolicyMarkdown` returns the
 * headings it emitted alongside the HTML.
 *
 * Why not import `marked`/`remark`? Policy pages are server-rendered once
 * per request, the content is fully trusted (admin-edited), and adding a
 * 50KB+ markdown lib to the storefront bundle for ~200 lines of policy
 * markup is overkill. This is ~70 lines, type-safe, and predictable.
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
  // Order matters: links before bold/italic (link text can contain emphasis).
  return s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${esc(u)}">${esc(t)}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => `<strong>${esc(t)}</strong>`)
    .replace(/\*([^*]+)\*/g, (_, t) => `<em>${esc(t)}</em>`);
}

function plain(s: string): string {
  return s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*+/g, "").trim();
}

function slugify(s: string): string {
  return plain(s).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "section";
}

export interface PolicyHeading {
  id: string;
  text: string;
}

export interface RenderedPolicy {
  html: string;
  /** H2s in order — the page's table of contents. */
  headings: PolicyHeading[];
}

/**
 * Render a policy's customer_summary. A leading `# Title` is dropped — the
 * page hero already shows the policy name, so repeating it reads as a stutter.
 */
export function renderPolicyMarkdown(md: string): RenderedPolicy {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const headings: PolicyHeading[] = [];
  const used = new Set<string>();
  let i = 0;
  let sawContent = false;

  // Section level = the shallowest heading level used after an optional
  // leading H1 title. Imported legal text (Terms, Privacy) uses ### for every
  // section, so a fixed "H2 = section" rule would give it no contents list.
  const firstHeading = lines.find((l) => l.trim());
  const levels = lines
    .filter((l, idx) => /^#{1,3}\s+/.test(l) && !(l === firstHeading && /^#\s+/.test(l) && idx === lines.indexOf(firstHeading)))
    .map((l) => (l.match(/^(#{1,3})/) as RegExpMatchArray)[1].length);
  const sectionLevel = levels.length ? Math.min(...levels) : 2;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      if (level === 1 && !sawContent) { sawContent = true; i++; continue; }
      sawContent = true;
      if (level <= sectionLevel) {
        let id = slugify(h[2]);
        for (let n = 2; used.has(id); n++) id = `${slugify(h[2])}-${n}`;
        used.add(id);
        headings.push({ id, text: plain(h[2]) });
        out.push(`<h2 id="${id}">${inline(h[2])}</h2>`);
      } else {
        out.push(`<h3>${inline(h[2])}</h3>`);
      }
      i++; continue;
    }
    sawContent = true;

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s+/.test(lines[i]) && !/^[-*]\s+/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
  }

  return { html: out.join("\n"), headings };
}
