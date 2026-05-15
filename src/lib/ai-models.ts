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
