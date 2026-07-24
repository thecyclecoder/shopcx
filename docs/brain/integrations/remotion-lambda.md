# Remotion Lambda — production ad rendering

Remotion can't render inside Vercel serverless functions (no headless Chromium/bundler → `remotion_not_installed`). Production ad renders run on **AWS Lambda** via `@remotion/lambda`; the Inngest step orchestrates (kick off + poll + collect) and Vercel stays light. Local dev still renders in-process.

Powers the render half of [[../lifecycles/ad-render]]. Toggled by `REMOTION_RENDER_MODE`.

## Env (Vercel + `.env.local`)

| Var | Notes |
|---|---|
| `REMOTION_RENDER_MODE` | `lambda` (prod) \| `local`/unset (in-process, dev) |
| `REMOTION_AWS_ACCESS_KEY_ID` / `REMOTION_AWS_SECRET_ACCESS_KEY` | IAM user with the Remotion Lambda policy (Remotion SDK reads these names) |
| `REMOTION_AWS_REGION` | default `us-east-1` |
| `REMOTION_LAMBDA_FUNCTION_NAME` | from `deployFunction` |
| `REMOTION_LAMBDA_SERVE_URL` | from `deploySite` |
| `REMOTION_S3_BUCKET` | from `getOrCreateBucket` |
| `OPENAI_API_KEY` | **must be in Vercel** — Whisper transcription runs in the Vercel Inngest assemble step (not on Lambda) |

## Deploy

`npx tsx scripts/deploy-remotion-lambda.ts` — idempotent. Runs `deployFunction` (240s timeout, 3008 MB, 10 GB disk) + `getOrCreateBucket` + `deploySite` (bundles `remotion/index.ts`), then prints the env values to set.

**Re-run `deploySite` whenever `remotion/` changes** (compositions, fonts, `ExampleAd`/`AdStatic`) — otherwise Lambda renders a stale bundle. See [[../operational-rules]] § Remotion site deploy. (The script does both function + site; re-running is safe.)

## How a render runs

`ad-render.ts` dispatches on `REMOTION_RENDER_MODE`:
- `renderVoSpineVideoTo(props, out)` → **lambda**: `renderMediaOnLambda({composition:"ExampleAd", inputProps, codec:"h264"})` → poll `getRenderProgress` (~5s) until `done` → download `outputFile` (S3) to `out`. **local**: in-process `renderVoSpineVideo`.
- `renderStaticTo(props, out)` → **lambda**: `renderStillOnLambda({composition:"AdStatic", imageFormat:"jpeg"})` → download `url`. **local**: `renderAdFormat`.

Segment clips reach Lambda as remote **signed URLs** (`ExampleAd`'s `resolveSrc` handles `https://`) — keep TTL ≥ 1h (renders finish in 1-3 min). The downloaded output is uploaded to our private `ad-tool` bucket; `ad_videos.meta.storage_path` is stored and the campaign GET **re-signs** `final_mp4_url`/`static_jpg_url` from it (links never go stale).

## IAM

The IAM user needs Remotion's Lambda policy (Lambda + S3 `remotionlambda-*` + CloudWatch). Generate via Remotion's docs / `npx remotion lambda policies`. Global infra (not per-workspace) — unlike Gemini/Higgsfield keys.

## Cost

Billed per render-second × memory. A ~16-22s 1080×1920 h264 is cheap; concurrency is capped by Inngest (`limit: 3` per workspace). Lambda timeout 240s is the per-render ceiling.

## Gotchas

- **Stale site** = forgot to re-run `deploySite` after editing `remotion/`.
- **`remotion_lambda_not_configured`** = `REMOTION_LAMBDA_FUNCTION_NAME`/`SERVE_URL` unset.
- **Version drift = `remotion_lambda_version_mismatch`.** The deployed function name carries its version as a dashed suffix (`remotion-render-4-0-471-mem...`). Any intentional `@remotion/*` bump MUST be paired with: (1) re-running `npx tsx scripts/deploy-remotion-lambda.ts`, (2) re-setting `REMOTION_LAMBDA_FUNCTION_NAME` in Vercel + `.env.local` to the new function name printed by the script. The six `@remotion/*` deps in `package.json` are **pinned (no carets)** to stop `npm audit fix` from silently bumping them past the deployed function. **Version mismatches are caught at predeploy time:** `scripts/_check-remotion-lambda-in-sync.ts` reads the pinned `@remotion/lambda` version from `package.json` and compares it to the `-N-N-N-` suffix embedded in `REMOTION_LAMBDA_FUNCTION_NAME` — if they disagree, the check exits non-zero with remediation steps (re-run `deploy-remotion-lambda.ts`), failing the PR at `npm run predeploy` instead of shipping a landmine into production. The runtime guard in `lambdaConfig()` (`src/lib/ad-render.ts`) still enforces the check at startup as a safety net.
- **`ws` override paired with the 4.0.471 pin.** `@remotion/renderer@4.0.471` transitively resolves `ws` to 8.20.1, which is HIGH-severity CVE-2026-48779 / GHSA-96hv-2xvq-fx4p (memory-exhaustion DoS, fixed in 8.21.0). Because the `@remotion/*` deps are pinned (no carets), `npm audit fix` cannot lift the nested `ws`. A top-level `"overrides": { "ws": "8.21.0" }` block in `package.json` forces every nested `ws` (including `node_modules/@remotion/renderer/node_modules/ws`) up to the patched 8.21.0 while leaving the `@remotion/*` 4.0.471 pin intact. Any future `@remotion/*` bump should re-check the transitive `ws` resolution and update or drop the override accordingly.
- Whisper runs on Vercel, not Lambda — `OPENAI_API_KEY` must be in Vercel or captions come back empty (the assemble step backfills transcripts; it needs the key).

## Related

[[../lifecycles/ad-render]] · [[../inngest/ad-tool]] · [[../libraries/gemini]] · [[../integrations/higgsfield]] · `scripts/deploy-remotion-lambda.ts`
