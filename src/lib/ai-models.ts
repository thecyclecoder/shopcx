/**
 * Single source of truth for Anthropic model IDs.
 *
 * When Anthropic deprecates a model, update the constant here and every
 * caller picks it up. Do NOT hardcode model strings anywhere else in the
 * codebase — import from this file instead.
 *
 * Pricing rows in `ai-usage.ts` reference these constants so the
 * cost-tracking layer stays in lockstep.
 */

export const SONNET_MODEL = "claude-sonnet-4-6";
export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const OPUS_MODEL = "claude-opus-4-7";

export const MODELS = {
  sonnet: SONNET_MODEL,
  haiku: HAIKU_MODEL,
  opus: OPUS_MODEL,
} as const;

export type ModelTier = keyof typeof MODELS;

/**
 * Box (`claude -p` on Max) model ids per tier — what `agent-model-tiers` `modelForKind` passes as
 * `--model`. Kept separate from MODELS so the box can track the newest subscription model without
 * moving every API-billed caller on Vercel. Opus is 4.8 here: since the 2026-10-02 setup-token switch
 * the CLI's unpinned default fell to Sonnet, and Sonnet ended ~half of ticket-handle sessions without
 * the final JSON (it writes the answer beside a TaskUpdate call, then ends on an empty or prose turn).
 */
export const BOX_MODELS: Record<ModelTier, string> = {
  ...MODELS,
  opus: "claude-opus-4-8",
};
