import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { registeredInngestFunctions } from "@/lib/inngest/registered-functions";

// 800s (Fluid Compute max) — single Inngest steps can run a long Sonnet call
// (per-ingredient research, per-chunk review analysis). 300s timed those out
// (FUNCTION_INVOCATION_TIMEOUT) and failed the product-intelligence runs.
export const maxDuration = 800;

// The served function list lives in src/lib/inngest/registered-functions.ts so the
// Control Tower self-audit can enumerate it at runtime (control-tower-complete-coverage
// spec, Phase 2). Add a new function THERE; this route picks it up automatically.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: registeredInngestFunctions,
});
