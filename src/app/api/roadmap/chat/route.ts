/**
 * POST /api/roadmap/chat — the roadmap authoring chat, now BOX-HOSTED (box-spec-chat).
 *
 * This route NO LONGER calls the Anthropic API. Each action enqueues a `kind='spec-chat'` agent_jobs
 * row that the build box claims and runs as a long-running, resumable `claude -p` session on Max
 * (full working-tree Read/Grep/Glob over docs/brain/ + src/, WebSearch, accumulated session context).
 * The route just appends the user message, flips the thread to `turn_status='thinking'`, and enqueues
 * the turn; the box appends the reply (the UI polls GET /api/roadmap/chat-session?id= until idle).
 *
 *   action "chat" (default):  { id?, message, slug?, seedSlug? } → enqueue {mode:'turn'} → { session }
 *   action "retry":           { id }                              → re-enqueue the last turn (resume)
 *   action "finalize":        { id, slug?, queueBuild }           → enqueue {mode:'finalize'} → { session }
 *   action "generate_verification": { slug }                      → enqueue {mode:'verify'}   → { queued }
 *
 * Owner-gated + workspace-scoped. The box generates; the worker (runSpecChatJob, deterministic Node
 * code holding prod creds) commits the spec to main + queues the build. See docs/brain/specs/box-spec-chat.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { saveChat, loadChat, markTurnThinking, type ChatMsg } from "@/lib/roadmap-chats";
import { getLatestSpecTestRuns, checkKey } from "@/lib/spec-test-runs";
import { getRoadmap } from "@/lib/brain-roadmap";

const isSlug = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9-]+$/i.test(s);
// A brain-relative seed slug (e.g. lifecycles/x) — path-guarded like the old read_brain_page.
const isBrainSlug = (s: unknown): s is string =>
  typeof s === "string" && /^[a-z0-9/_-]+$/i.test(s) && !s.includes("..");

async function requireOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return { error: NextResponse.json({ error: "No workspace" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || member.role !== "owner") {
    return { error: NextResponse.json({ error: "Only the workspace owner can author specs" }, { status: 403 }) };
  }
  return { user, workspaceId, admin };
}

type SpecChatMode = "turn" | "finalize" | "verify";

/** Is a spec-chat job for this thread already in flight? (belt-and-suspenders over the UI's disable.) */
async function hasActiveSpecChatJob(admin: ReturnType<typeof createAdminClient>, specSlug: string): Promise<boolean> {
  const { data } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("kind", "spec-chat")
    .eq("spec_slug", specSlug)
    .in("status", ["queued", "queued_resume", "building"])
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

/** Enqueue one spec-chat turn/finalize/verify job. spec_slug labels the row (the chat id, or the spec). */
async function enqueueSpecChat(
  admin: ReturnType<typeof createAdminClient>,
  opts: { workspaceId: string; userId: string; specSlug: string; instructions: Record<string, unknown> },
) {
  await admin.from("agent_jobs").insert({
    workspace_id: opts.workspaceId,
    kind: "spec-chat",
    spec_slug: opts.specSlug,
    status: "queued",
    instructions: JSON.stringify(opts.instructions),
    created_by: opts.userId,
  });
}

export async function POST(request: Request) {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;
  const { user, workspaceId, admin } = auth;

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    messages?: ChatMsg[]; // legacy field — ignored now that the DB owns the transcript
    slug?: string;
    seedSlug?: string;
    action?: "chat" | "retry" | "finalize" | "generate_verification" | "propose_fix";
    queueBuild?: boolean;
  };

  const action = body.action ?? "chat";
  const refineSlug = isSlug(body.slug) ? body.slug : undefined;
  const seedSlug =
    !refineSlug && typeof body.seedSlug === "string" && isBrainSlug(body.seedSlug.trim().replace(/\.md$/, ""))
      ? body.seedSlug.trim().replace(/\.md$/, "")
      : undefined;

  // generate_verification — standalone (no chat thread): a FRESH box run that Reads specs/{slug}.md
  // + the brain and emits a "## Verification" section; the worker commits it to main. (VerificationCard.)
  if (action === "generate_verification") {
    if (!refineSlug) return NextResponse.json({ error: "slug required" }, { status: 400 });
    const verifySlug = `verify:${refineSlug}`;
    if (await hasActiveSpecChatJob(admin, verifySlug)) return NextResponse.json({ queued: true, already: true });
    await enqueueSpecChat(admin, {
      workspaceId,
      userId: user.id,
      specSlug: verifySlug,
      instructions: { mode: "verify" as SpecChatMode, slug: refineSlug },
    });
    return NextResponse.json({ queued: true });
  }

  // propose_fix — regression escalation (spec-test-agent Phase 2). A shipped spec FAILED its own
  // spec-test (an auto-`fail`); seed a fresh authoring chat with the regression brief (the failing
  // checks + evidence) and enqueue the first box turn, so the owner can review the box's proposed fix
  // and finalize it into a fix spec. The owner triggers it + finalizes — the agent only proposes.
  if (action === "propose_fix") {
    if (!refineSlug) return NextResponse.json({ error: "slug required" }, { status: 400 });
    const slug = refineSlug;
    const [runs, { specs }] = await Promise.all([getLatestSpecTestRuns(workspaceId), getRoadmap()]);
    const run = runs[slug];
    const failing = (run?.checks ?? []).filter((c) => c.verdict === "fail");
    if (!run || failing.length === 0) {
      return NextResponse.json({ error: "no regression to fix — the latest spec-test has no failing checks" }, { status: 400 });
    }
    const title = specs.find((s) => s.slug === slug)?.title ?? slug;
    // fix-ship-retests-origin: the spec-test `check_key`(s) this fix targets — the same 16-hex hash
    // [[spec-test-runs#checkKey]] keys runs by. The `**Regression-of:** [[origin]]` line populates the
    // typed `specs.regression_of_slug` column when the fix is authored (author-spec.extractRegressionHeaders),
    // and that column is what `retestOriginIfFixMerged` reads after the fix build merges (no markdown
    // fetch — retire-md-reads-from-pm-flow Phase 2). The `**Fixes:** … (check …)` line stays for human
    // traceability of which failing checks this fix targets.
    const checkKeys = failing.map((c) => checkKey(c.text)).join(", ");
    const brief = [
      `The shipped spec "${title}" (\`${slug}\`) FAILED its own ## Verification when the box spec-test QA agent last ran it — a likely regression or an incomplete build.`,
      "",
      "Failing checks:",
      ...failing.map((c, i) => `${i + 1}. [check ${checkKey(c.text)}] ${c.text}${c.evidence ? `\n   evidence: ${c.evidence}` : ""}`),
      "",
      `Investigate each failure against the spec + the brain + the code, then propose a concise FIX spec: what's broken, what to change and where, and how to re-verify it. When we finalize, author the fix spec through the author-spec SDK (a row in public.specs + public.spec_phases — the DB is the spec), owned by [[../functions/platform]], parented under the same mandate/goal as the original where sensible. Never commit a docs/brain/specs/*.md file.`,
      "",
      `IMPORTANT — when you finalize the fix spec, include BOTH machine-readable metadata lines directly under the \`**Owner:** … · **Parent:** …\` line, verbatim (they link the fix back to the spec it resolves so the origin auto-re-tests once this fix ships — do not paraphrase or omit them):`,
      `\`**Regression-of:** [[${slug}]]\``,
      `\`**Fixes:** ${slug} (check ${checkKeys})\``,
    ].join("\n");
    const created = await saveChat({
      id: undefined,
      workspaceId,
      userId: user.id,
      specSlug: null,
      title: `Fix: ${slug}`,
      messages: [{ role: "user", content: brief }],
    });
    if (!created) return NextResponse.json({ error: "could not start fix chat" }, { status: 500 });
    const session = await markTurnThinking(workspaceId, created.id);
    await enqueueSpecChat(admin, {
      workspaceId,
      userId: user.id,
      specSlug: created.id,
      instructions: { mode: "turn" as SpecChatMode, chat_id: created.id },
    });
    return NextResponse.json({ queued: true, chatId: created.id, session });
  }

  // All other actions operate on a persisted thread. Resolve/create the roadmap_chats row.
  let chatId = typeof body.id === "string" && body.id ? body.id : undefined;
  let createdWithMessage = false; // a fresh row already holds the opening user message — don't re-append
  if (!chatId) {
    if (action !== "chat" || !body.message?.trim()) {
      return NextResponse.json({ error: "chat id required" }, { status: 400 });
    }
    // First turn of a brand-new thread — create the row with the opening user message.
    const title = refineSlug ? `Refine: ${refineSlug}` : body.message.trim().slice(0, 80) || "New feature";
    const created = await saveChat({
      id: undefined,
      workspaceId,
      userId: user.id,
      specSlug: refineSlug ?? null,
      title,
      messages: [{ role: "user", content: body.message.trim() }],
    });
    if (!created) return NextResponse.json({ error: "could not start chat" }, { status: 500 });
    chatId = created.id;
    createdWithMessage = true;
  }

  const existing = await loadChat(workspaceId, chatId);
  if (!existing) return NextResponse.json({ error: "chat not found" }, { status: 404 });

  // Don't double-enqueue while a turn is already on the box (the UI disables, but guard anyway).
  if (existing.turn_status === "thinking" && (await hasActiveSpecChatJob(admin, chatId))) {
    return NextResponse.json({ session: existing });
  }

  if (action === "finalize") {
    if (existing.messages.length === 0) return NextResponse.json({ error: "nothing to finalize" }, { status: 400 });
    const session = await markTurnThinking(workspaceId, chatId);
    await enqueueSpecChat(admin, {
      workspaceId,
      userId: user.id,
      specSlug: chatId,
      instructions: {
        mode: "finalize" as SpecChatMode,
        chat_id: chatId,
        slug: refineSlug,
        seedSlug,
        queueBuild: !!body.queueBuild,
      },
    });
    return NextResponse.json({ session });
  }

  // action "chat" (append a new user message) or "retry" (re-run the last turn with no new message).
  // A just-created row already holds the opening message, so don't append it twice.
  const userMessage = action === "retry" || createdWithMessage ? undefined : body.message?.trim();
  if (action === "chat" && !createdWithMessage && !userMessage && existing.messages.length === 0) {
    return NextResponse.json({ error: "empty message" }, { status: 400 });
  }
  const session = await markTurnThinking(workspaceId, chatId, userMessage);
  await enqueueSpecChat(admin, {
    workspaceId,
    userId: user.id,
    specSlug: chatId,
    instructions: { mode: "turn" as SpecChatMode, chat_id: chatId, slug: refineSlug, seedSlug },
  });
  return NextResponse.json({ session });
}
