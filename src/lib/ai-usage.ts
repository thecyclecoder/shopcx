/**
 * Token-usage logging for Claude API calls. Anthropic returns precise
 * input/output token counts on every response — we capture them in
 * ai_token_usage so analytics can compute per-ticket cost and per-
 * purpose token burn.
 *
 * Usage shape (Anthropic responses include this):
 *   data.usage = { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
 *
 * Pricing reference (Apr 2026, may drift):
 *   sonnet-4: $3/M input, $15/M output
 *   haiku-4.5: $1/M input, $5/M output
 *   opus-4.7: $15/M input, $75/M output
 */
import { createAdminClient } from "@/lib/supabase/admin";

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface LogParams {
  workspaceId: string;
  model: string;
  usage: ClaudeUsage | undefined | null;
  purpose?: string;
  ticketId?: string | null;
}

/**
 * Fire-and-forget — never throws into the calling path. If the log
 * fails, the customer-facing flow keeps running.
 */
export async function logAiUsage({ workspaceId, model, usage, purpose, ticketId }: LogParams): Promise<void> {
  if (!usage || (!usage.input_tokens && !usage.output_tokens)) return;
  try {
    const admin = createAdminClient();
    await admin.from("ai_token_usage").insert({
      workspace_id: workspaceId,
      model,
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_creation_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_tokens: usage.cache_read_input_tokens || 0,
      purpose: purpose || null,
      ticket_id: ticketId || null,
    });
  } catch (err) {
    console.error("[ai-usage] log failed:", err);
  }
}

// Cost per 1K tokens — keep in sync with Anthropic pricing.
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  // input/output cents per 1K tokens
  "claude-sonnet-4-20250514":   { input: 0.30, output: 1.50, cacheRead: 0.03 },
  "claude-sonnet-4":            { input: 0.30, output: 1.50, cacheRead: 0.03 },
  "claude-haiku-4-5-20251001":  { input: 0.10, output: 0.50, cacheRead: 0.01 },
  "claude-haiku-4-5":           { input: 0.10, output: 0.50, cacheRead: 0.01 },
  "claude-opus-4-7":            { input: 1.50, output: 7.50, cacheRead: 0.15 },
};

/**
 * Calculate cost in cents for a usage row. Cache reads are billed at
 * 10% of input rate; cache creation at 125% of input.
 */
export function usageCostCents(model: string, row: { input_tokens: number; output_tokens: number; cache_creation_tokens: number; cache_read_tokens: number }): number {
  const p = PRICING[model] || PRICING["claude-sonnet-4-20250514"];
  const fromInput = (row.input_tokens / 1000) * p.input;
  const fromOutput = (row.output_tokens / 1000) * p.output;
  const fromCacheRead = (row.cache_read_tokens / 1000) * p.cacheRead;
  const fromCacheCreate = (row.cache_creation_tokens / 1000) * p.input * 1.25;
  return fromInput + fromOutput + fromCacheRead + fromCacheCreate;
}
