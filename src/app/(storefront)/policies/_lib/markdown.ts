/**
 * Minimal Markdown → HTML converter for policy pages. Intentionally limited
 * to the subset we use in customer_summary:
 *   • # H1 / ## H2 / ### H3
 *   • paragraphs separated by blank lines
 *   • **bold**, *italic*
 *   • [text](url) links
 *   • - or * bullet lists
 *
 * Why not import `marked`/`remark`? Policy pages are server-rendered once
 * per request, the content is fully trusted (admin-edited), and adding a
 * 50KB+ markdown lib to the storefront bundle for ~200 lines of policy
 * markup is overkill. This is ~50 lines, type-safe, and predictable.
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
  // Order matters: links before bold/italic (link text can contain emphasis).
  return s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) =>
      `<a href="${esc(u)}" class="text-emerald-700 underline underline-offset-2 hover:text-emerald-900">${esc(t)}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => `<strong>${esc(t)}</strong>`)
    .replace(/\*([^*]+)\*/g, (_, t) => `<em>${esc(t)}</em>`);
}

export function renderPolicyMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Blank line → close any open paragraph below
    if (!line.trim()) { i++; continue; }

    // Heading
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const cls = level === 1
        ? "text-3xl md:text-4xl font-semibold tracking-tight text-zinc-900 mt-10 first:mt-0 mb-4"
        : level === 2
        ? "text-xl md:text-2xl font-semibold text-zinc-900 mt-8 mb-3"
        : "text-lg font-semibold text-zinc-900 mt-6 mb-2";
      out.push(`<h${level} class="${cls}">${inline(h[2])}</h${level}>`);
      i++; continue;
    }

    // Bullet list — consume consecutive bullet lines
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li class="ml-6 list-disc">${inline(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul class="space-y-1.5 text-zinc-800 leading-relaxed my-4">${items.join("")}</ul>`);
      continue;
    }

    // Paragraph — accumulate non-blank, non-heading, non-bullet lines
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s+/.test(lines[i]) && !/^[-*]\s+/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) {
      out.push(`<p class="text-zinc-800 leading-relaxed text-[17px] my-4">${inline(para.join(" "))}</p>`);
    }
  }

  return out.join("\n");
}
