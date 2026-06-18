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

async function askOpus(system: string, messages: Msg[], maxTokens: number): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: OPUS, max_tokens: maxTokens, system, messages }),
  });
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n").trim();
}

function kebab(s: string): string {
  return s.replace(/[⏳🚧✅]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled-spec";
}

const BASE_SYSTEM = `You are a senior engineer + PM helping Dylan (founder of Superfoods Company) shape a build spec for ShopCX. Specs live in docs/brain/specs/{slug}.md and are executed by an autonomous build agent, so they must be concrete.

A good spec has: a one-paragraph summary tied to a business outcome; concrete "## Phase N — name" sections with file paths / schema / tasks, each line-tagged with ⏳ planned · 🚧 in progress · ✅ shipped; a "## Safety / invariants" section; and "## Completion criteria". Ground it in real ShopCX tables/libraries where you can. Ask clarifying questions when the goal is ambiguous. Keep phases small and verifiable. Be concise, plain text, no markdown fluff in your chat replies.`;

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
    action?: "chat" | "finalize";
    queueBuild?: boolean;
  };
  const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
  const refineSlug = typeof body.slug === "string" && /^[a-z0-9-]+$/i.test(body.slug) ? body.slug : null;

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
  const system = refineSlug
    ? `${BASE_SYSTEM}\n\nYou are REFINING the existing spec docs/brain/specs/${refineSlug}.md. Discuss changes/additions; preserve shipped (✅) phases unless told otherwise. Current content:\n\n${current}`
    : BASE_SYSTEM;

  if (body.action !== "finalize") {
    const reply = await askOpus(system, messages, 2000);
    return NextResponse.json({ reply });
  }

  // finalize → produce the full spec markdown, commit it, optionally queue a build
  const finalizeMsgs: Msg[] = [
    ...messages,
    { role: "user", content: "Output ONLY the complete spec markdown file content now — no preamble, no code fences, no commentary. Begin with '# <Title> <status emoji>'." },
  ];
  let markdown = await askOpus(system, finalizeMsgs, 8000);
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
