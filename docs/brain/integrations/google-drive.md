# Google Drive API (read-only) — box asset library

**Why:** the build box sources isolated product packshots + the `Hero Example` reference set from the shared **Superfoods Company/Assets/Products** library to feed Nano Banana Pro hero generation ([[../specs/box-product-seeding]]). The claude.ai Drive MCP connector that authored/verified the spec is **interactive-only** — not available to the headless box — so a service account is the box's path.

## Auth

- **Service account** with the **Drive API (read-only)** enabled. JSON key stored **AES-256-GCM-encrypted** per workspace: `workspaces.google_drive_sa_json_encrypted` (migration `20260619210000_workspace_gdrive_sa.sql`, decrypt via [[../libraries/crypto]]).
- **Sharing:** the `Assets/Products` folder is shared to the SA's email (`…@….iam.gserviceaccount.com`) as **Viewer**.
- **Flow:** sign a JWT (`RS256`, scope `drive.readonly`) with the SA private key → exchange at `oauth2.googleapis.com/token` for an access token → `Authorization: Bearer`. Same pattern as [[google-search-console]].
- Set up via `scripts/apply-gdrive-sa.ts` (adds the column + stores the encrypted key).

## Endpoints used

| Op | Endpoint | Use |
|---|---|---|
| list | `GET /drive/v3/files?q=…` (`includeItemsFromAllDrives`) | resolve product folders + image files |
| download | `GET /drive/v3/files/{id}?alt=media` | fetch packshot / Hero Example bytes |

## Client

[[../libraries/google-drive]] — `DriveClient.forWorkspace()` + `resolveProductShots()`. Asset-resolver quirks (per-variant files, Pods↔K-Cups interchangeable, front-facing bag = primary hero) live there.

## Related
[[../libraries/google-drive]] · [[../libraries/gemini]] · [[../specs/box-product-seeding]] · [[../tables/workspaces]] · [[../lifecycles/product-intelligence]]
