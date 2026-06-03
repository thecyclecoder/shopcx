# Settings · settings/integrations (ad-tool addendum)

The integrations hub is canonically documented at [[settings/integrations]]. This page is the ad-tool addendum: the **Higgsfield** card.

**Route:** `/dashboard/settings/integrations`

## Higgsfield card

Powers the [[../lifecycles/ad-render|ad tool]]. Unlike the single-key integrations, Higgsfield is **dual-credential** — an **API key** and a **secret**, both pasted in the card:

- Stored AES-256-GCM encrypted on `workspaces`: `higgsfield_api_key_encrypted` + `higgsfield_secret_encrypted` ([[../libraries/crypto]]).
- **Verify connection** button → `probeHiggsfieldAuth` (`GET /v1/motions`) confirms the key+secret pair before save.
- Sent on every ad-tool call as `hf-api-key` + `hf-secret` headers. No global account — strictly per-workspace.

## API endpoints called

- `/api/workspaces/:x/integrations` — save / verify credentials

## Permissions

Owner / admin (credential entry).

## Files touched

- `src/app/dashboard/settings/integrations/page.tsx` — the card lives here
- `src/lib/higgsfield.ts` — `getHiggsfieldCredentials` + `probeHiggsfieldAuth`

## Related

[[settings/integrations]] · [[../integrations/higgsfield]] · [[../lifecycles/ad-render]]

---

[[../README]] · [[../../CLAUDE]]
