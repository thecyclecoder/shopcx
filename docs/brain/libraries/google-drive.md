# `src/lib/google-drive.ts` — Google Drive (read-only) service-account client

Headless Drive access for the build box. Sources isolated product packshots + the `Hero Example` reference set from the shared **Superfoods Company/Assets/Products** library to feed Nano Banana Pro hero generation ([[../specs/box-product-seeding]] step 6). The claude.ai Drive MCP connector is **interactive-only** (absent on the headless box), so the box authenticates with a Google Cloud **service-account JSON key**.

- **Auth:** JWT → token exchange (same shape as [[google-search-console]]), scope `https://www.googleapis.com/auth/drive.readonly`.
- **Credentials:** `workspaces.google_drive_sa_json_encrypted` (AES-256-GCM via [[crypto]], migration `20260619210000_workspace_gdrive_sa.sql`). The `Assets/Products` folder is **shared to the SA's email as Viewer**.
- **Two Drive ops:** `files.list` (resolve folders/files) + `files.get?alt=media` (download bytes).

## Exports

| Export | Shape | Notes |
|---|---|---|
| `getDriveConfig(workspaceId)` | `→ { credentials } \| null` | decrypts the SA JSON; `null` if missing/invalid |
| `DriveClient.forWorkspace(workspaceId)` | `→ DriveClient \| null` | builds a token-bearing session for one box run |
| `drive.list(q, pageSize?)` | `→ DriveFile[]` | raw Drive `q`; includes shared-drive results (`includeItemsFromAllDrives`) |
| `drive.findFolders(name)` | `→ DriveFile[]` | folders whose name contains `name` |
| `drive.listImagesInFolder(folderId)` | `→ DriveFile[]` | image files directly in a folder |
| `drive.listSubfolders(folderId)` | `→ DriveFile[]` | subfolders directly in a folder |
| `drive.download(fileId)` | `→ { buffer, mimeType } \| null` | `files.get?alt=media` |
| `resolveProductShots(drive, { productName, variantKeywords?, preferBag? })` | `→ DriveFile[]` (ranked) | finds the product folder, gathers images from it + one level of subfolders, ranks candidates |

## `resolveProductShots` ranking — the documented quirks

Browses (never hardcodes) because subfolder structure varies per product (`Isolated Product Shots` vs `3D Renders`). Scores each candidate: **+variant match** (Pods ↔ K-Cups treated as interchangeable), **+front-facing**, **+bag** (the primary hero — stick packs/pods are alternates), **+isolated**, **−stick**. Best-first. The caller ([[product-intelligence-seed]] `seed-tools.resolvePackshot`) downloads the top candidate and the `seed-product` skill **vision-confirms** it (native Read) before use.

## Constants

| Const | Value |
|---|---|
| `HERO_EXAMPLE_FOLDER_ID` | `16uLBC5o3bxSv-PR6i_O9XS5FXMZRZ6xo` — the proven composition/style reference set (`Assets/Products/Hero Example`) |

## Callers

- [[product-intelligence-seed]] (`seed-tools.resolvePackshot`) — packshot + Hero Example fetch for the `seed-product` skill's Nano Banana Pro hero.

## Related
[[../integrations/google-drive]] · [[gemini]] · [[crypto]] · [[google-search-console]] · [[../tables/workspaces]] · [[../specs/box-product-seeding]]
