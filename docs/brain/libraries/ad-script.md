# libraries/ad-script

Ad tool — Phase 3 script generator. Turns a chosen angle (+ length) into a Hook / Body / CTA spoken script via Opus, then runs the Direct Response Validator, retrying up to 3x on fatal violations before surfacing them. The render gate ([[ad-render]]) validates again.

**File:** `src/lib/ad-script.ts` · Model: `OPUS_MODEL` from [[ai-models]] · See [[ad-validator]], [[ad-tool-config]].

## Exports

### `generateScript` — function

```ts
function generateScript(args: GenerateScriptArgs, maxAttempts = 3): Promise<GeneratedScript>

interface GenerateScriptArgs {
  angle: ProductAdAngle;
  inputs: AngleGeneratorInput;
  lengthSec: 15 | 30;
  bannedWords?: string[];
  workspaceId: string;
  seed?: number; // varies regenerate output; incremented per attempt
}
interface GeneratedScript {
  ok: boolean; script: string; hook: string; body: string; cta: string;
  violations: Violation[]; attempts: number; reason?: string;
}
```

Builds a system prompt from the angle's `hook_slug` template + `lf8_slot` + banned words, asks Opus for three labelled lines (`HOOK:` / `BODY:` / `CTA:`), splits them, validates the joined script via `validateAdScript`, and returns on the first `ok` attempt (or the last attempt's result). Logs usage per attempt (`logAiUsage`, purpose `ad_script_generation`).

Re-exports `estimateSpokenSeconds` from [[ad-validator]].

## Callers

- `src/app/api/ads/campaigns/route.ts` — generates the script when a campaign is created

## Gotchas

- Target spoken length is `lengthSec - 1` (1s buffer); prompt asks for ≈ `talkSec × 2.6` words. The 30s hard cap is enforced by the validator, not the prompt.
- `seed` is incremented by the attempt number so each retry produces different copy rather than re-rolling the same failing script.
- No API key → returns `{ ok:false, reason:"no_api_key" }` rather than throwing.
- Central promise must rest on a tier-1/2 benefit; reviews may be cited as backing only (mirrors [[ad-validator]] `review_as_promise`).

---

[[../README]] · [[../../CLAUDE]]
