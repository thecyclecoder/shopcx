/**
 * POST /api/roadmap/chat — Opus authoring chat for specs (the cheap API spend).
 *   action "chat":     { messages, slug? }            → { reply }
 *   action "finalize": { messages, slug?, queueBuild } → commits docs/brain/specs/{slug}.md
 *                                                        to main (create or refine) + optional build
 *
 * Owner-gated. New spec OR refine an existing one (loads current content from GitHub).
 * See docs/brain/specs/roadmap-build-console.md (Phase 2).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBrainTree } from "@/lib/brain-tree";

const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
const OPUS = "claude-opus-4-8";

function ghToken() {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}
async function gh(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : {} };
}

type Msg = { role: "user" | "assistant"; content: string };

// Phase 1 — compact brain index (folder/slug — title) injected into the system prompt so
// Opus knows what already exists and references real pages instead of inventing names.
// Memoized per lambda instance (getBrainTree walks ~600 files reading each H1).
let brainIndexCache: string | null = null;
async function brainIndex(): Promise<string> {
  if (brainIndexCache != null) return brainIndexCache;
  try {
    const { files } = await getBrainTree();
    brainIndexCache = files.map((f) => `${f.slug} — ${f.title}`).join("\n");
  } catch {
    brainIndexCache = "";
  }
  return brainIndexCache;
}

// Phase 2 — read-only lookup tools (GitHub-API-backed, so no Vercel file-tracing needed).
// Brain-first per the house rule; grep_repo over src/ is the deeper fallback.
const BRAIN_TOOLS = [
  {
    name: "read_brain_page",
    description:
      "Read a full brain page (docs/brain/<slug>.md) to ground the spec in real ShopCX tables/libraries/lifecycles/integrations. slug is the brain-relative path WITHOUT .md, e.g. 'tables/storefront_sessions' or 'lifecycles/roadmap-build-console' — pick it from the brain index in the system prompt. Brain-first: prefer this over grep_repo.",
    input_schema: {
      type: "object",
      properties: { slug: { type: "string", description: "Brain-relative slug without .md, e.g. tables/agent_jobs" } },
      required: ["slug"],
    },
  },
  {
    name: "grep_repo",
    description:
      "Search the ShopCX codebase via GitHub code search when the brain lacks the detail (exact column names, an existing function). Returns matching file paths with snippets. Fallback AFTER the brain.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword/symbol to search for, e.g. createAdminClient" },
        path: { type: "string", description: "Optional path filter, e.g. src/lib" },
      },
      required: ["query"],
    },
  },
];

async function runBrainTool(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    if (name === "read_brain_page") {
      const slug = String(input.slug || "").trim().replace(/\.md$/, "");
      if (!/^[a-z0-9/_-]+$/i.test(slug) || slug.includes("..")) return "error: invalid slug";
      const get = await gh("GET", `/repos/${REPO}/contents/docs/brain/${slug}.md?ref=main`);
      if (!get.ok) return `error: brain page not found: ${slug}`;
      const text = Buffer.from(String(get.json.content || "").replace(/\s/g, ""), "base64").toString("utf8");
      return text.length > 12000 ? text.slice(0, 12000) + "\n…[truncated]" : text;
    }
    if (name === "grep_repo") {
      const query = String(input.query || "").trim();
      if (!query) return "error: empty query";
      const scope = input.path ? ` path:${String(input.path).trim()}` : "";
      const q = encodeURIComponent(`${query} repo:${REPO}${scope}`);
      const res = await fetch(`https://api.github.com/search/code?q=${q}&per_page=20`, {
        headers: {
          Authorization: `Bearer ${ghToken()}`,
          Accept: "application/vnd.github.text-match+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      });
      if (!res.ok) return `error: code search ${res.status}`;
      const data = (await res.json()) as { items?: { path: string; text_matches?: { fragment?: string }[] }[] };
      const items = data.items || [];
      if (!items.length) return "no matches";
      return items
        .slice(0, 20)
        .map((it) => {
          const frag = (it.text_matches || [])
            .map((m) => (m.fragment || "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .slice(0, 2)
            .join(" … ");
          return frag ? `${it.path}: ${frag}` : it.path;
        })
        .join("\n")
        .slice(0, 6000);
    }
    return `error: unknown tool ${name}`;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

type ToolMsg = { role: "user" | "assistant"; content: unknown };

// Anthropic Messages call with the read-only brain/codebase tool loop. Opus resolves
// specifics (real tables, existing functions) mid-draft instead of emitting OPEN: …TBD.
async function askOpus(system: string, messages: Msg[], maxTokens: number): Promise<string> {
  const convo: ToolMsg[] = messages.map((m) => ({ role: m.role, content: m.content }));
  let finalText = "";
  for (let turn = 0; turn < 8; turn++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: OPUS, max_tokens: maxTokens, system, tools: BRAIN_TOOLS, messages: convo }),
    });
    if (!res.ok) break;
    const data = (await res.json()) as { content?: Record<string, unknown>[]; stop_reason?: string };
    const content = data.content || [];
    for (const b of content) {
      const t = (b as { text?: unknown }).text;
      if (b.type === "text" && typeof t === "string") finalText = t;
    }
    const toolUses = content.filter((b) => b.type === "tool_use");
    if (data.stop_reason !== "tool_use" || toolUses.length === 0) break;
    convo.push({ role: "assistant", content });
    convo.push({
      role: "user",
      content: await Promise.all(
        toolUses.map(async (tu) => ({
          type: "tool_result",
          tool_use_id: tu.id as string,
          content: await runBrainTool(tu.name as string, (tu.input as Record<string, unknown>) || {}),
        })),
      ),
    });
  }
  return finalText.trim();
}

function kebab(s: string): string {
  return s.replace(/[⏳🚧✅]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled-spec";
}

// verification-guides — Opus authors a "## Verification" test plan for a spec. Concrete + prod-facing
// so the owner can actually verify shipped work before archiving it.
const VERIFY_SYSTEM = `You are writing ONLY the "## Verification" section for a ShopCX spec — a concrete, prod-facing test checklist the OWNER follows to confirm the feature actually works in production before archiving it.

Rules:
- Output ONLY the section. Start with the literal line "## Verification". No preamble, no code fences, no other "##" sections.
- 3-7 bullets. Each is a single concrete, human-reproducible step: the exact route (e.g. /dashboard/roadmap/box), Slack action, or CLI command — the input — and the OBSERVABLE expected result. Shape: "- On {where}, {do what} → expect {observable result}."
- Use the REAL routes / tables / Slack actions / files the spec touched. You have the spec below plus read_brain_page + grep_repo — look up real names, never invent them.
- NEVER write vague steps like "verify it works" or "check the feature". Every bullet names a concrete place and a concrete expected observation.
- Only live-app prod paths — no unit-test / CI / "run the test suite" instructions.`;

/** Insert or replace a "## Verification" section in spec markdown — before "## Related" if present, else appended. */
function upsertVerification(markdown: string, section: string): string {
  const body = section.trim();
  const lines = markdown.split("\n");
  const isH2 = (i: number) => /^##\s/.test(lines[i]);
  const start = lines.findIndex((l) => /^##\s+Verification\b/i.test(l));
  if (start !== -1) {
    let end = start + 1;
    while (end < lines.length && !isH2(end)) end++;
    return [...lines.slice(0, start), body, "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
  }
  const rel = lines.findIndex((l) => /^##\s+Related\b/i.test(l));
  if (rel !== -1) {
    return [...lines.slice(0, rel), body, "", ...lines.slice(rel)].join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
  }
  return markdown.replace(/\s+$/, "") + "\n\n" + body + "\n";
}

const BASE_SYSTEM = `You are a senior engineer + PM helping Dylan (founder of Superfoods Company) shape a build spec for ShopCX. Specs live in docs/brain/specs/{slug}.md and are executed by an autonomous build agent, so they must be concrete.

A good spec has: a metadata line directly under the H1 — \`**Owner:** [[../functions/{slug}]] · **Parent:** {a function mandate or a goal milestone}\` (every spec declares exactly one owner function + a parent; no orphans — see docs/brain/project-management.md); a one-paragraph summary tied to a business outcome; concrete "## Phase N — name" sections with file paths / schema / tasks, each line-tagged with ⏳ planned · 🚧 in progress · ✅ shipped; a "## Safety / invariants" section; "## Completion criteria"; and a "## Verification" section — a concrete, prod-facing test checklist (exact route/Slack action/CLI + input + observable expected result, e.g. "- On /dashboard/roadmap/box, queue a build → expect that lane to show the slug + elapsed timer"), never vague "test it works".

Ground every spec in what ShopCX ACTUALLY has. You have a brain index below (the curated map of every table/library/lifecycle/integration) plus read-only tools: read_brain_page(slug) to read a full brain page, and grep_repo(query) to search the codebase when the brain lacks the detail. Brain-first (read docs/brain/ before grepping src/). Use them while drafting to resolve real table/column/function names — NEVER emit "OPEN: …TBD" placeholders for anything you can look up; look it up. Ask clarifying questions only for genuine product decisions. Keep phases small and verifiable. Be concise, plain text, no markdown fluff in your chat replies.`;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can author specs" }, { status: 403 });
  }
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as {
    messages?: Msg[];
    slug?: string;
    seedSlug?: string;
    action?: "chat" | "finalize" | "generate_verification";
    queueBuild?: boolean;
  };
  const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
  const refineSlug = typeof body.slug === "string" && /^[a-z0-9-]+$/i.test(body.slug) ? body.slug : null;
  // Re-hydration ("New spec from brain"): a brain-relative slug (e.g. lifecycles/x) to seed a FRESH spec
  // from the CURRENT brain. Ignored when refining an existing spec. Path-guarded like read_brain_page.
  const seedSlugRaw = typeof body.seedSlug === "string" ? body.seedSlug.trim().replace(/\.md$/, "") : "";
  const seedSlug = !refineSlug && seedSlugRaw && /^[a-z0-9/_-]+$/i.test(seedSlugRaw) && !seedSlugRaw.includes("..") ? seedSlugRaw : null;

  // For refine: pull the current spec content (+ sha for the later commit).
  let current = "";
  let currentSha: string | undefined;
  if (refineSlug) {
    const get = await gh("GET", `/repos/${REPO}/contents/docs/brain/specs/${refineSlug}.md?ref=main`);
    if (get.ok) {
      current = Buffer.from(String(get.json.content || "").replace(/\s/g, ""), "base64").toString("utf8");
      currentSha = get.json.sha as string;
    }
  }
  // Re-hydration: load the seed brain page's CURRENT content so Opus drafts against live reality.
  let seedContent = "";
  if (seedSlug) {
    const get = await gh("GET", `/repos/${REPO}/contents/docs/brain/${seedSlug}.md?ref=main`);
    if (!get.ok) return NextResponse.json({ error: `brain page not found: ${seedSlug}` }, { status: 404 });
    seedContent = Buffer.from(String(get.json.content || "").replace(/\s/g, ""), "base64").toString("utf8");
    if (seedContent.length > 12000) seedContent = seedContent.slice(0, 12000) + "\n…[truncated]";
  }

  const index = await brainIndex();
  const grounding = index ? `\n\n## ShopCX brain index — the curated map of what already exists (slug — title; read full pages with read_brain_page)\n${index}` : "";
  const system = refineSlug
    ? `${BASE_SYSTEM}${grounding}\n\nYou are REFINING the existing spec docs/brain/specs/${refineSlug}.md. Discuss changes/additions; preserve shipped (✅) phases unless told otherwise. Current content:\n\n${current}`
    : seedSlug
    ? `${BASE_SYSTEM}${grounding}\n\nYou are drafting a NEW spec by RE-HYDRATING from the current brain page docs/brain/${seedSlug}.md (an already-shipped feature or a reference page). Read it below as the source of truth for what exists TODAY, then help Dylan shape a fresh spec that EXTENDS or FIXES it — never just restate it, and never reactivate a stale snapshot. Inherit the owner/parent taxonomy from the page where sensible. All new phases start ⏳. Current page content:\n\n${seedContent}`
    : `${BASE_SYSTEM}${grounding}`;

  // verification-guides Phase 3 — generate a "## Verification" test plan for an existing spec and commit it.
  if (body.action === "generate_verification") {
    if (!refineSlug) return NextResponse.json({ error: "slug required" }, { status: 400 });
    if (!current) return NextResponse.json({ error: `spec not found: ${refineSlug}` }, { status: 404 });
    const verifySystem = `${VERIFY_SYSTEM}${grounding}\n\nThe spec you are writing verification steps for (docs/brain/specs/${refineSlug}.md):\n\n${current}`;
    let section = await askOpus(verifySystem, [{ role: "user", content: "Write the ## Verification section for this spec now." }], 4000);
    section = section.replace(/^```(?:markdown)?\s*/i, "").replace(/```\s*$/i, "").trim();
    if (!/^##\s+Verification\b/i.test(section)) section = `## Verification\n${section}`;
    const updated = upsertVerification(current, section);
    const put = await gh("PUT", `/repos/${REPO}/contents/docs/brain/specs/${refineSlug}.md`, {
      message: `verification-guides: generate test plan for ${refineSlug}`,
      content: Buffer.from(updated, "utf8").toString("base64"),
      sha: currentSha,
      branch: "main",
    });
    if (!put.ok) return NextResponse.json({ error: "commit failed", status: put.status }, { status: 502 });
    return NextResponse.json({ slug: refineSlug, generated: true });
  }

  if (body.action !== "finalize") {
    const reply = await askOpus(system, messages, 8000);
    return NextResponse.json({ reply });
  }

  // finalize → produce the full spec markdown, commit it, optionally queue a build
  const finalizeMsgs: Msg[] = [
    ...messages,
    { role: "user", content: "Output ONLY the complete spec markdown file content now — no preamble, no code fences, no commentary. Begin with '# <Title> <status emoji>'." },
  ];
  let markdown = await askOpus(system, finalizeMsgs, 16000);
  markdown = markdown.replace(/^```(?:markdown)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!markdown.startsWith("#")) return NextResponse.json({ error: "model did not return a spec" }, { status: 502 });

  const title = (markdown.split("\n")[0] || "").replace(/^#\s*/, "");
  const slug = refineSlug || kebab(title);
  const path = `docs/brain/specs/${slug}.md`;

  const put = await gh("PUT", `/repos/${REPO}/contents/${path}`, {
    message: `spec: ${refineSlug ? "refine" : "create"} ${slug} (authoring chat)`,
    content: Buffer.from(markdown, "utf8").toString("base64"),
    sha: currentSha,
    branch: "main",
  });
  if (!put.ok) return NextResponse.json({ error: "commit failed", status: put.status }, { status: 502 });

  let queued = false;
  if (body.queueBuild) {
    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: slug,
      status: "queued",
      instructions: refineSlug ? "Refined via authoring chat" : "Created via authoring chat",
      created_by: user.id,
    });
    queued = !error;
  }
  return NextResponse.json({ slug, title: title.replace(/[⏳🚧✅]/g, "").trim(), queued });
}
