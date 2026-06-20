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
| `resolveProductShots(drive, { productName, variantKeywords?, preferBag? })` | `→ DriveFile[]` (ranked) | finds the product folder, sources candidates from its **`Isolated Product Shots` subfolder ONLY**, ranks them |

## `resolveProductShots` ranking — the documented quirks

**Hero source is the `Isolated Product Shots` subfolder ONLY** (matched by name containing `isolated`). It **never** pulls from `3D Renders` / `Pickleball` / `UGC` / `Lifestyle` / `Social` — those hold box/carton renders + scene shots, and sourcing from them once gave a box render (`AswaVANA Orange Passion IFC`) as the Guru Focus hero instead of its 30-count stand-up **bag**. If a product has no `Isolated Product Shots` subfolder yet, it falls back to the product-folder **root** images (still filtering out any excluded-folder-keyword names), never traversing those subfolders. Scores each candidate: **+variant match** (Pods ↔ K-Cups interchangeable), **+front-facing**, **+bag/pouch/stand-up** (the multi-serving retail unit — the primary hero), **+isolated**, **−stick** (single-serve), **−box/carton/IFC** (not the retail bag). Best-first. The caller ([[product-intelligence-seed]] `seed-tools.resolvePackshot`) downloads the top candidate and the `seed-product` skill **vision-confirms** it (native Read) before use.

## Constants

| Const | Value |
|---|---|
| `HERO_EXAMPLE_FOLDER_ID` | `16uLBC5o3bxSv-PR6i_O9XS5FXMZRZ6xo` — the proven composition/style reference set (`Assets/Products/Hero Example`) |

## Callers

- [[product-intelligence-seed]] (`seed-tools.resolvePackshot`) — packshot + Hero Example fetch for the `seed-product` skill's Nano Banana Pro hero.

## Related
[[../integrations/google-drive]] · [[gemini]] · [[crypto]] · [[google-search-console]] · [[../tables/workspaces]] · [[../specs/box-product-seeding]]
