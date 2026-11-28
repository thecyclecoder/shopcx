/**
 * Public AI shopping-agent MCP server (docs/brain/integrations/ai-assistant-mcp.md · Phase 2 + 3).
 *
 * ONE remote MCP endpoint that ChatGPT, Claude and Grok all connect to over HTTPS. MCP Streamable
 * HTTP transport, STATELESS JSON-RPC: POST handles `initialize`, `tools/list`, `tools/call`,
 * `resources/list`, `resources/read`; GET → 405. `[workspace]` resolves exactly like the storefront
 * segment (getWorkspaceBySlug). Per-IP rate limiting; the client name from `initialize.clientInfo`
 * (or the User-Agent) labels the platform (chatgpt/claude/grok/other).
 *
 * North-star trio: the node is OWNED (`ai:shopping-agent-mcp` → cmo in the registry), SWITCHABLE
 * (resolveEffectiveSwitch returns a polite "temporarily unavailable" tool error when off), and
 * HEARTBEATS (emitInlineAgentHeartbeat at the end of every request). Every tool call is logged to
 * shopping_agent_calls with REDACTED args (never the raw shopper health text).
 *
 * Read-only tools pass every returned string through the compliance module before it leaves the
 * server; build_cart is the one writer (hands off to our own Braintree storefront checkout).
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceBySlug } from "@/app/(storefront)/_lib/page-data";
import { resolveEffectiveSwitch } from "@/lib/control-tower/kill-switch-resolver";
import { emitInlineAgentHeartbeat } from "@/lib/control-tower/heartbeat";
import { INLINE_AGENT_IDS } from "@/lib/control-tower/registry";
import { SHOPPING_AGENT_TOOLS, TOOLS_BY_NAME, type ToolContext } from "@/lib/shopping-agent/tools";
import { UI_RESOURCES, UI_RESOURCES_BY_URI } from "@/lib/shopping-agent/resources";
import { logShoppingAgentCall, platformFromClientName, type ShoppingAgentPlatform } from "@/lib/shopping-agent/calls";
import { MANDATORY_DISCLAIMER } from "@/lib/shopping-agent/compliance";
import type { AiAgentPlatform } from "@/lib/shopping-agent/cart";
import { errText } from "@/lib/error-text";

const NODE_ID = INLINE_AGENT_IDS.shoppingAgentMcp; // "ai:shopping-agent-mcp"
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "shopcx-shopping-agent", version: "1.0.0" };

/* ── Per-IP rate limiting (in-memory, best-effort). ──────────────────────────────────────────── */
const RATE_LIMIT = 60; // requests
const RATE_WINDOW_MS = 60_000; // per minute
const ipHits = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hit = ipHits.get(ip);
  if (!hit || now > hit.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  hit.count += 1;
  return hit.count > RATE_LIMIT;
}
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  return (xff ? xff.split(",")[0] : "").trim() || req.headers.get("x-real-ip") || "unknown";
}

/* ── JSON-RPC helpers. ───────────────────────────────────────────────────────────────────────── */
type JsonRpcId = string | number | null;
/**
 * MCP Apps tool `_meta`: the spec shape is the NESTED `_meta.ui.resourceUri` (SEP-1865); the flat
 * `ui/resourceUri` key is the deprecated alias older hosts read; `openai/outputTemplate` is ChatGPT's
 * Apps SDK alias. A dotted flat key ("ui.resourceUri") is read by no host, so cards never rendered.
 */
function uiMeta(uri: string): Record<string, unknown> {
  return { ui: { resourceUri: uri }, "ui/resourceUri": uri, "openai/outputTemplate": uri };
}

interface JsonRpcReq { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: Record<string, unknown> }
function ok(id: JsonRpcId, result: unknown) { return { jsonrpc: "2.0", id: id ?? null, result }; }
function err(id: JsonRpcId, code: number, message: string) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

/** Redact tool args for the supervision log — whitelist non-health fields ONLY (never raw text). */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["product_id", "handle", "pack_tier", "mode", "frequency_days"]) {
    if (args[k] != null) out[k] = args[k];
  }
  // Note presence of a free-text situation/question WITHOUT storing the text (spec: no health text).
  if (typeof args.situation === "string") out.has_situation = true;
  if (typeof args.question === "string") out.has_question = true;
  return out;
}

export async function GET() {
  return NextResponse.json(
    err(null, -32000, "This MCP endpoint speaks JSON-RPC over POST (Streamable HTTP)."),
    { status: 405 },
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ workspace: string }> }) {
  const start = Date.now();
  let okBeat = true;
  try {
    const { workspace: workspaceSlug } = await params;

    // Rate limit per IP.
    if (rateLimited(clientIp(request))) {
      okBeat = false;
      return NextResponse.json(err(null, -32005, "Rate limit exceeded. Please slow down."), { status: 429 });
    }

    const workspace = await getWorkspaceBySlug(workspaceSlug);
    if (!workspace) return NextResponse.json(err(null, -32004, "Unknown workspace."), { status: 404 });
    const workspaceId = workspace.id as string;

    let body: JsonRpcReq;
    try { body = (await request.json()) as JsonRpcReq; }
    catch { return NextResponse.json(err(null, -32700, "Parse error."), { status: 400 }); }

    const id = body.id ?? null;
    const method = body.method ?? "";
    const rpcParams = body.params ?? {};

    // Platform label — from initialize.clientInfo when present, else the User-Agent.
    const clientName =
      (rpcParams.clientInfo as { name?: string } | undefined)?.name ?? request.headers.get("user-agent") ?? "";
    const platform: ShoppingAgentPlatform = platformFromClientName(clientName);

    switch (method) {
      case "initialize":
        return NextResponse.json(ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: SERVER_INFO,
          instructions: "Recommend Superfoods products by the shopper's situation and answer from verified product intelligence. " + MANDATORY_DISCLAIMER,
        }));

      case "tools/list":
        return NextResponse.json(ok(id, {
          tools: SHOPPING_AGENT_TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
            ...(t.uiResourceUri
              ? { _meta: uiMeta(t.uiResourceUri) }
              : {}),
          })),
        }));

      case "resources/list":
        return NextResponse.json(ok(id, {
          resources: UI_RESOURCES.map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })),
        }));

      case "resources/read": {
        const uri = String(rpcParams.uri ?? "");
        const res = UI_RESOURCES_BY_URI.get(uri);
        if (!res) return NextResponse.json(err(id, -32602, `Unknown resource: ${uri}`));
        return NextResponse.json(ok(id, { contents: [{ uri: res.uri, mimeType: res.mimeType, text: res.text }] }));
      }

      case "tools/call": {
        const name = String(rpcParams.name ?? "");
        const args = (rpcParams.arguments as Record<string, unknown>) ?? {};
        const tool = TOOLS_BY_NAME.get(name);
        if (!tool) return NextResponse.json(err(id, -32602, `Unknown tool: ${name}`));

        // Kill switch — polite "temporarily unavailable" tool error when off (route stays up).
        const sw = await resolveEffectiveSwitch(NODE_ID);
        if (sw.off) {
          return NextResponse.json(ok(id, {
            isError: true,
            content: [{ type: "text", text: "The shopping assistant is temporarily unavailable. Please try again soon." }],
          }));
        }

        const admin = createAdminClient();
        const ctx: ToolContext = { admin, workspaceId, platform: platform as AiAgentPlatform, blocked: { count: 0 }, productIds: new Set<string>() };
        let structured: unknown;
        try {
          structured = await tool.handler(ctx, args);
        } catch (e) {
          okBeat = false;
          return NextResponse.json(ok(id, { isError: true, content: [{ type: "text", text: `Tool error: ${errText(e)}` }] }));
        }

        // Supervision log — redacted args, result product ids, blocked-claim count, latency.
        await logShoppingAgentCall(admin, workspaceId, {
          platform,
          tool: name,
          args: redactArgs(args),
          resultProductIds: [...ctx.productIds],
          blockedClaimCount: ctx.blocked.count,
          latencyMs: Date.now() - start,
        });

        return NextResponse.json(ok(id, {
          content: [{ type: "text", text: JSON.stringify(structured) }],
          structuredContent: structured,
          ...(tool.uiResourceUri
            ? { _meta: uiMeta(tool.uiResourceUri) }
            : {}),
        }));
      }

      default:
        return NextResponse.json(err(id, -32601, `Method not found: ${method}`));
    }
  } catch (e) {
    okBeat = false;
    return NextResponse.json(err(null, -32603, `Internal error: ${errText(e)}`), { status: 500 });
  } finally {
    await emitInlineAgentHeartbeat(NODE_ID, { ok: okBeat, durationMs: Date.now() - start });
  }
}
