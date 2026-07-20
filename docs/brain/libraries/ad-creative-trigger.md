# ad-creative-trigger

`src/lib/ads/ad-creative-trigger.ts` — the **WRITE chokepoint** for "make an ad for this product." One call takes a product (+ optional audience temperature) and starts a **Dahlia/Max ping-pong box session**. Companion to the read-side [[ads-read-sdk.md]].

## Why it exists

Enqueuing ad generation by hand kept reaching for the **wrong job kind**:
- `kind='ad-creative'` is the **cadence** kind whose copy path is gated behind `DAHLIA_COPY_MODE`; unset (the default) → it silently runs the deterministic `buildMetaCopyPack` **node engine** — no box session, no Max copy-QC, no LF8/Schwartz treatments. This is what put un-graded own-brand ads in the bin.
- `kind='ad-creative-copy-author'` is the runner that **forces** the author + Max copy-QC box session regardless of any flag.

This SDK **always** enqueues the latter (`AD_CREATIVE_SESSION_KIND`), so a trigger can only ever produce a real Dahlia/Max creative — never a node-path ad. It's the write-side complement to the box-session-only rail in [[creative-agent.md]].

## Surface

| Export | What |
|---|---|
| `triggerAdGeneration(admin, {workspaceId, productId, temperature?, count?, reason?})` | Enqueues one `ad-creative-copy-author` job → returns `{jobId, kind, productId, temperature, count}`. **Manual/explicit trigger** — does NOT consult the ad-creative kill switch (a human asking for one ad ≠ the autonomous cadence). |
| `buildAdGenerationInstructions(input)` | PURE — the instructions payload the runner reads. Unit-tested. Defaults: `temperature: "cold"`, `count: 1`. |
| `AD_CREATIVE_SESSION_KIND` | `"ad-creative-copy-author"` — the box-session-forcing kind. |
| `AdAudienceTemperature` | `"cold" \| "warm" \| "hot"`. |

## Temperature flow (how the input actually drives the run)

`temperature` is written onto the job instructions → `runAdCreativeCopyAuthorJob` ([[../../../scripts/builder-worker.ts]]) reads it and threads a `CreativeIntent` (`{audience_temperature, purpose:'test-to-find-winner'}`) into `runAdCreativeLoop` → `stockProduct`, which scopes winner research + angle selection to that temperature (cold prospecting prefers unaware/problem-aware competitor winners; warm/hot rank their own bands first). Omitted ⇒ `stockProduct`'s default (`cold`).

## Usage

```ts
import { triggerAdGeneration } from "@/lib/ads/ad-creative-trigger";
// "make Ashwavana Guru Focus cold audience ad"
const { jobId } = await triggerAdGeneration(admin, { workspaceId, productId: GURU, temperature: "cold", reason: "ceo-manual" });
// verify it ran through the session, once produced:
import { traceAdOrigin } from "@/lib/ads/ads-read-sdk";
```

## Callers

- **`POST /api/ads/generate`** (owner/admin + hero-product gated) — the self-service **"Generate ad"** button on each [[../dashboard/research__ads]] competitor card. Body `{workspaceId, productId, temperature}` → `triggerAdGeneration`. The owner picks temperature (cold/warm/hot) + a target hero product (defaults to the card's product); the SDK's box-session-only guarantee is what lets the button promise "5 psychological treatments + Max copy-QC" without a way to bypass into the node path. (CEO 2026-07-20 — "instead of me having to come to the CLI to ask for ads.")
- Manual CLI / `scripts/_*.ts` one-offs (bench a temperature before flipping the workspace flag).

## Related

[[ads-read-sdk.md]] (read/verify side — `traceAdOrigin`) · [[../dashboard/research__ads]] (the "Generate ad" UI caller) · [[creative-agent.md]] (`runAdCreativeLoop` / `stockProduct` / `CreativeIntent`) · [[../inngest/ad-creative-cadence.md]] (the autonomous cadence — kill-switch-gated) · [[../functions/growth.md]]
