# Spec: production ad rendering via Remotion Lambda

**Status:** 🚧 code shipped, awaiting AWS creds for live deploy + verify · **Owner:** Dylan

> **Progress (2026-06):** Phases 1–5 implemented, typechecked, **and verified**: `@remotion/lambda` dep, `scripts/deploy-remotion-lambda.ts`, Lambda render dispatch in `ad-render.ts` (`renderVoSpineVideoTo`/`renderStaticTo` behind `REMOTION_RENDER_MODE`), Whisper backfill in the render assemble step, URL re-signing in the campaign GET, brain docs ([[../integrations/remotion-lambda]]). Verified: the Lambda SDK resolves (`deployFunction`/`renderMediaOnLambda`/`getRenderProgress`/`renderStillOnLambda`) and the new dispatcher renders an ad end-to-end in **local** mode (2 talking + 2 b-roll + music + 35 captions → 23 MB mp4).
>
> **AWS CLI ready:** installed (2.34.62); Remotion IAM policies generated in `scripts/aws/` + one-shot `scripts/aws/setup-remotion-aws.sh`.
>
> **Remaining — blocked on the operator authenticating AWS** (`aws configure` with admin creds; cannot be done by the agent). Then: (1) `bash scripts/aws/setup-remotion-aws.sh` → creates `remotion-user`/`remotion-lambda-role` + prints keys; (2) add `REMOTION_AWS_*` to `.env.local` + Vercel; (3) `npx tsx scripts/deploy-remotion-lambda.ts` → function + site + bucket; (4) set `REMOTION_LAMBDA_FUNCTION_NAME`/`REMOTION_LAMBDA_SERVE_URL`/`REMOTION_S3_BUCKET` + `REMOTION_RENDER_MODE=lambda` + `OPENAI_API_KEY` in Vercel; (5) render an ad from the app on `lambda` mode; (6) fold + delete this spec.

## Why

The ad pipeline produces all the pieces correctly (hero, Veo talking heads, b-roll, Lyria music, composition, captions), but the final **render cannot run in production**. `ad-tool/render-requested` throws `remotion_not_installed` because Remotion needs a headless Chromium + bundler that Vercel serverless functions don't provide. Today renders are done by hand with a local `tsx` script — not self-serve.

Two coupled gaps to close:
1. **Render runtime** — move the Remotion render to **Remotion Lambda** (AWS Lambda + S3), the official serverless renderer. The Inngest step orchestrates (kick off + poll + collect); Lambda does the heavy lifting. Vercel stays light.
2. **Captions reliability** — production talking-head clips came back with **0 Whisper words** (captions silently empty). Make transcription bulletproof so captions always populate.

When this ships, an operator clicks **Render** on `/dashboard/marketing/ads/[id]` and gets all 4 formats back automatically, with captions and b-roll — no local scripts.

## Background (what already works — don't rebuild)

- Pieces persist to the creative library: [[../tables/ad_segments]] + `ad_campaigns.composition`. See [[../libraries/ad-segments]].
- The canonical video composition is `remotion/ExampleAd.tsx` (VO spine + muted/ASMR b-roll + Lyria bed + one-at-a-time Hormozi captions); static is `remotion/AdStatic.tsx`. Registered in `remotion/Root.tsx`.
- `ad-render.ts` already builds the props + captions: `buildVoCaptions` (proofread vs script, numbers + `%` preserved), `renderVoSpineVideo` (currently local bundler+renderMedia), `renderAdFormat` (static).
- The render assemble step in `src/lib/inngest/ad-tool.ts` already: loads active segments, generates Lyria if missing, `buildComposition` + `saveComposition`, resolves signed URLs, builds captions, then renders each of 4 formats.
- ExampleAd already resolves remote signed URLs (`resolveSrc`) — so Lambda can fetch segment clips directly.
- **Proven locally**: the exact composition renders correctly (the approved Amazing Coffee ad). This spec only changes *where* the render executes, not the creative logic.

## Approach

Use `@remotion/lambda`. Two deploy-time artifacts (provisioned once, re-deployed when `remotion/` changes), then a per-render call from Inngest.

```
Inngest render-requested (Vercel, light)
  └─ assemble: segments → composition → captions (+ Whisper fallback)
  └─ per format:
       renderMediaOnLambda / renderStillOnLambda  →  { renderId, bucketName }
       poll getRenderProgress until done           →  outputFile (S3)
       copy S3 output → our private ad-tool bucket  →  ad_videos.final_mp4_url (re-signable)
```

Keep a `REMOTION_RENDER_MODE` env flag (`lambda` | `local`) so local dev still uses the in-process renderer; production uses `lambda`.

## Phases

### Phase 1 — AWS + Lambda provisioning ⏳
- Add `@remotion/lambda` dependency.
- AWS account + IAM user with the Remotion Lambda policy (per Remotion docs: `remotionlambda-*` S3, Lambda, CloudWatch). Creds via env (Remotion reads `REMOTION_AWS_ACCESS_KEY_ID` / `REMOTION_AWS_SECRET_ACCESS_KEY`).
- `scripts/deploy-remotion-lambda.ts`: `deployFunction({ region, timeoutInSeconds: 240, memorySizeInMb: 3008, diskSizeInMb })` → prints the function name. Idempotent (Remotion names functions by version; reuse if present).
- **Env vars** (Vercel + `.env.local`): `REMOTION_AWS_REGION`, `REMOTION_AWS_ACCESS_KEY_ID`, `REMOTION_AWS_SECRET_ACCESS_KEY`, `REMOTION_LAMBDA_FUNCTION_NAME`, `REMOTION_S3_BUCKET`, `REMOTION_RENDER_MODE=lambda`.
- **Acceptance:** `deployFunction` succeeds; function name captured in env.

### Phase 2 — Deploy the composition site ⏳
- In `scripts/deploy-remotion-lambda.ts` (or a sibling): `deploySite({ entryPoint: remotion/index.ts, bucketName, siteName: "shopcx-ads", region })` → `serveUrl`. Store as `REMOTION_LAMBDA_SERVE_URL`.
- **Must re-run whenever `remotion/` changes** (new convention — add to [[../operational-rules]] alongside the portal-build note). Consider a `predeploy` hook or CI step.
- Verify fonts (`@remotion/google-fonts/Anton`) bundle into the site; verify `resolveSrc` handles `https://` (it does).
- **Acceptance:** `serveUrl` resolves; `ExampleAd` + `AdStatic` listed on the site.

### Phase 3 — Lambda render path in `ad-render.ts` ⏳
- Add `renderVoSpineVideoLambda(props, { videoId })` and `renderStillLambda(props)` using `renderMediaOnLambda` / `renderStillOnLambda` (from `@remotion/lambda/client`) + `getRenderProgress` polling (respect Inngest step time; poll loop with backoff, ~4-8s, fatalError → throw with the Lambda error).
- Output: download `outputFile` from S3 → return a Buffer (caller uploads to our `ad-tool` bucket) OR copy S3→bucket directly. Prefer our bucket so access control + URLs stay consistent.
- Gate behind `REMOTION_RENDER_MODE`: `lambda` → on-Lambda; `local`/unset → existing `renderVoSpineVideo`/`renderAdFormat` (dev).
- **Acceptance:** a unit/integration script renders one format on Lambda and returns a valid mp4/jpg.

### Phase 4 — Captions never empty (Whisper reliability) ⏳
- Root cause: production talking-head produced 0 Whisper words (likely `OPENAI_API_KEY` missing in Vercel env, and `transcribeWords` failures are swallowed).
- In the render **assemble** step: for each active talking segment with empty `transcript_json.words`, transcribe it (Whisper) and persist before `buildVoCaptions` — so captions populate regardless of when the talking head was made. (This is the manual step we ran by hand; make it automatic.)
- Make transcription failures **visible**: write the error to `ad_segments.error` / video `meta` instead of silently empty.
- Ensure `OPENAI_API_KEY` is set in Vercel. (transcribeWords runs in the Vercel Inngest function, not on Lambda.)
- **Acceptance:** rendering a campaign whose talking clips lack transcripts still yields captioned output.

### Phase 5 — Wire Inngest render → Lambda, all 4 formats ⏳
- `adToolRenderRequested` render-formats step: call the Lambda render path for video formats (`ExampleAd` at each format's dims via `FORMAT_SPECS`) and static (`AdStatic`). Remove the in-process Remotion assumption from the production path.
- Keep the per-format `ad_videos` rows + `final_mp4_url`/`static_jpg_url`/status semantics unchanged.
- Store `meta.storage_path` and have the campaign GET **re-sign** `final_mp4_url` from `storage_path` on read (fix the 90-day-link durability nit).
- **Acceptance:** clicking Render on the dashboard produces 4 ready `ad_videos` rows with working URLs, captions, and b-roll — no local scripts, no `remotion_not_installed`.

### Phase 6 — Verify end-to-end + brain docs + fold ⏳
- Full app run: build an ad (hero → talking → b-roll → music) → Render → watch all 4 formats land. Confirm captions + b-roll + music + numbers/`%`.
- Brain: update [[../lifecycles/ad-render]] (render now Lambda), new [[../integrations/remotion-lambda]] page (deploy steps, env, IAM, cost), [[../inngest/ad-tool]] render section, [[../operational-rules]] (re-deploy site on `remotion/` change). Update [[../libraries/ad-render]].
- Delete this spec; update [specs/README](README.md).

## Risks / decisions
- **AWS creds**: Dylan provides an IAM user with Remotion's policy (global infra, not per-workspace).
- **Cost**: Lambda render is billed per second × memory; a ~16s 1080×1920 h264 is cheap but note it. Cap concurrency (Inngest already keys concurrency=3/workspace).
- **Signed-URL TTL during render**: segment URLs passed to Lambda must outlive the render (use ≥1h; renders finish in 1-3 min).
- **Site freshness**: forgetting to re-run `deploySite` after editing `remotion/` ships stale compositions — hence the operational-rules note.
- **Fallback**: `REMOTION_RENDER_MODE=local` keeps the in-process renderer for local dev and as an escape hatch.

## Definition of done
An operator renders an ad entirely from `/dashboard/marketing/ads/[id]` → 4 captioned, b-roll-and-music outputs, produced on Lambda, durable URLs, zero local scripts. Brain updated; spec folded + deleted.
