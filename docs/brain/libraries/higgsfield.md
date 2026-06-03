# libraries/higgsfield

Higgsfield Cloud API client. One vendor covers the three generative surfaces the ad tool needs — Soul (image), DoP (image→video b-roll), Speak (talking-head lip-sync), plus Audio (TTS). Dual-credential, per-workspace, AES-256-GCM encrypted on `workspaces`. Every call is logged to [[../tables/ad_jobs]] for cost-audit and replay.

**File:** `src/lib/higgsfield.ts` · See integration page [[../integrations/higgsfield]], [[crypto]], [[../inngest/ad-tool]].

## Exports

| Export | Signature / cost |
|---|---|
| `getHiggsfieldCredentials(workspaceId)` | `→ {apiKey, secret} \| null` — decrypts `higgsfield_api_key_encrypted` + `higgsfield_secret_encrypted` |
| `loggedHiggsfieldFetch(args)` | signs request (`hf-api-key` + `hf-secret`), calls Higgsfield, writes an `ad_jobs` row unless `persist:false`. Returns `{ok,status,json,jobId}` |
| `createCharacter({workspaceId,name,imageUrls})` | mint a persistent character — **40 credits (~$2.50)** |
| `generateSoulImage(args)` | avatar+product hero image — **~3 credits @ 1080p** |
| `generateSoulPortrait({workspaceId,prompt,quality?,seed?})` | Soul **TEXT-TO-IMAGE** (no existing character) — mints a brand-new avatar face candidate from the four attributes (gender/age/health/ethnicity), so the operator never has to upload reference photos. **~3 credits each.** Chosen portrait is then fed to `createCharacter`. |
| `generateDopVideo(args)` | image→video b-roll clip (5s) — **~9 credits (~$0.56)** |
| `generateSpeakVideo(args)` | talking-head lip-sync — **~$0.10/sec, max 15s/gen** |
| `generateTtsAudio({workspaceId,text,voiceId})` | text-to-speech for the script |
| `getJobStatus(workspaceId, jobSetId)` | poll once → normalized `{status, outputUrls}` |
| `pollJobUntilDone(workspaceId, jobSetId, opts?)` | poll until terminal (5s interval, 240s timeout default) |
| `listMotions(workspaceId)` / `listStyles(workspaceId)` | static catalogs (not persisted) |
| `probeHiggsfieldAuth(workspaceId)` | cheap auth check for the settings "verify" step |
| `creditsToCents(credits)` | `→ round(credits / 16 × 100)` |

Constants: `CREDITS_PER_DOLLAR = 16`, `HIGGSFIELD_MODELS = { soul, dop, speak }`. Status enum: `queued | in_progress | completed | failed | nsfw`.

## Callers

- `src/lib/inngest/ad-tool.ts` — every generation stage (hero / audio / talking-head / b-roll)
- Settings "verify" flow → `probeHiggsfieldAuth`

## Gotchas

- **Dual credential.** Both `hf-api-key` AND `hf-secret` headers are required. There is NO global Higgsfield account — every call resolves one workspace's creds; missing creds throw `higgsfield_not_connected`.
- **NSFW jobs STILL bill.** `status='nsfw'` is terminal and the credits (~$0.50) are eaten — surface it clearly, don't silently retry.
- **Every billable call writes `ad_jobs`** (`loggedHiggsfieldFetch`, `persist` defaults on). Probe/list calls pass `persist:false` and skip persistence. Request payloads are credential-redacted before storage.
- Endpoint paths + payload shapes are the **integration contract** gathered from published references — verify against live Higgsfield docs when wiring real credentials.
- Async only: mutating calls return a `job_set_id`; you must poll. `getJobStatus` normalizes Higgsfield's varied status/output shapes.

---

[[../README]] · [[../../CLAUDE]] · [[../tables/ad_jobs]] · [[../integrations/higgsfield]]
