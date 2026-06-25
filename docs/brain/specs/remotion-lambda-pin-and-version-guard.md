# Pin @remotion/* exact versions + fail fast on Lambda version mismatch

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `package.json (drop carets on the six @remotion/* deps — bundler, cli, google-fonts, lambda, renderer, remotion — and pin to 4.0.471 to match the live lambda), src/lib/ad-render.ts (lambdaconfig() reads @remotion/lambda/package.json version and parses the 4-0-xxx suffix from remotion_lambda_function_name; throws remotion_lambda_version_mismatch: pkg=x function=y — re-run scripts/deploy-remotion-lambda.ts if they differ), docs/brain/integrations/remotion-lambda.md (add a gotchas bullet that any @remotion/* bump must be paired with re-running the deploy script + re-setting remotion_lambda_function_name in vercel).::real-bug`
**Repair-signature:** `vercel:4be6412563688e4b`

Stop Remotion package versions from silently drifting past the deployed AWS Lambda function during routine `npm audit fix` runs, and surface any future drift as a clear startup error from `ad-render.ts` instead of a per-render failure inside Inngest.

## Problem (from Control Tower signature `vercel:4be6412563688e4b`)
After commit a5640766 (security-dep-upgrades) ran `npm audit fix --package-lock-only`, the caret ranges on all six `@remotion/*` entries in `package.json` (`^4.0.471`) let the lockfile resolve to 4.0.482. The AWS Lambda function deployed by `scripts/deploy-remotion-lambda.ts` is still `remotion-render-4-0-471-mem3008mb-disk10240mb-240sec`. Result: every `[featured-review-cards]` (and any other `renderStillOnLambda`/`renderMediaOnLambda` caller — `renderStaticOnLambda`, `renderVoSpineVideoOnLambda`, `renderStillCompositionOnLambda`) throws `Version mismatch: ... function has version 4.0.471, but the @remotion/lambda package you used to invoke the function has version 4.0.482`. Errors observed in /api/inngest at 2026-06-25T11:00 (signatures vercel:4be6412563688e4b, ee33ecab).

**Likely target:** `package.json (drop carets on the six `@remotion/*` deps — bundler, cli, google-fonts, lambda, renderer, remotion — and pin to 4.0.471 to match the live Lambda), src/lib/ad-render.ts (`lambdaConfig()` reads `@remotion/lambda/package.json` version and parses the `4-0-XXX` suffix from `REMOTION_LAMBDA_FUNCTION_NAME`; throws `remotion_lambda_version_mismatch: pkg=X function=Y — re-run scripts/deploy-remotion-lambda.ts` if they differ), docs/brain/integrations/remotion-lambda.md (add a Gotchas bullet that any `@remotion/*` bump must be paired with re-running the deploy script + re-setting `REMOTION_LAMBDA_FUNCTION_NAME` in Vercel).`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `vercel:4be6412563688e4b`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:4be6412563688e4b` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
