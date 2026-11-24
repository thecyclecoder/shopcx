/**
 * shopping_agent_calls SDK — the write chokepoint for the AI shopping-agent supervision log
 * (docs/brain/tables/shopping_agent_calls.md · Phase 2). One row per MCP tool call, with REDACTED
 * args only — never the raw shopper health text (spec: "No shopper health text persisted").
 *
 * Best-effort: logging must never break the tool call it reports on, so `logShoppingAgentCall`
 * swallows + logs its own errors (mirrors the heartbeat module's best-effort contract).
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The AI apps we label by `initialize.clientInfo` name. */
export type ShoppingAgentPlatform = "chatgpt" | "claude" | "grok" | "other";

/** Map a raw MCP `clientInfo.name` to a coarse platform label (never stores the raw name). */
export function platformFromClientName(name: string | null | undefined): ShoppingAgentPlatform {
  const n = (name ?? "").toLowerCase();
  if (n.includes("chatgpt") || n.includes("openai")) return "chatgpt";
  if (n.includes("claude") || n.includes("anthropic")) return "claude";
  if (n.includes("grok") || n.includes("xai")) return "grok";
  return "other";
}

/** A single supervision-log write. `args` must already be redacted by the caller. */
export interface ShoppingAgentCallInput {
  platform: ShoppingAgentPlatform;
  tool: string;
  /** Redacted — coarse fields only (e.g. { situation_slug, product_id }). No free-text health details. */
  args?: Record<string, unknown>;
  resultProductIds?: string[];
  blockedClaimCount?: number;
  latencyMs?: number;
}

/**
 * Append one supervision-log row. Best-effort — never throws (a logging failure must not fail the
 * shopper's tool call). Returns void.
 */
export async function logShoppingAgentCall(
  admin: Admin,
  workspaceId: string,
  input: ShoppingAgentCallInput,
): Promise<void> {
  try {
    await admin.from("shopping_agent_calls").insert({
      workspace_id: workspaceId,
      platform: input.platform,
      tool: input.tool,
      args: input.args ?? {},
      result_product_ids: input.resultProductIds ?? [],
      blocked_claim_count: input.blockedClaimCount ?? 0,
      latency_ms: input.latencyMs ?? null,
    });
  } catch (err) {
    console.warn(`[shopping-agent] logShoppingAgentCall failed (non-fatal): ${err}`);
  }
}
