/**
 * Google Drive (read-only) — headless service-account client for the build box.
 *
 * The box sources isolated product packshots + the Hero Example reference set
 * from the shared "Superfoods Company/Assets/Products" library to feed Nano
 * Banana Pro hero generation (box-product-seeding). The claude.ai Drive MCP
 * connector is interactive-only (absent on the headless box), so we authenticate
 * with a Google Cloud service-account JSON key stored AES-256-GCM-encrypted on
 * the workspace (`workspaces.google_drive_sa_json_encrypted`). The Assets/Products
 * folder is shared to the SA's email as Viewer.
 *
 * Auth follows the same JWT→token exchange as google-search-console.ts, with the
 * Drive read-only scope. Two Drive ops: files.list (resolve folders/files) +
 * files.get?alt=media (download bytes).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

// The proven Hero Example reference set (Assets/Products/Hero Example) — the
// approved composition/style the box feeds Nano Banana Pro alongside the packshot.
export const HERO_EXAMPLE_FOLDER_ID = "16uLBC5o3bxSv-PR6i_O9XS5FXMZRZ6xo";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
}

export async function getDriveConfig(workspaceId: string): Promise<{ credentials: ServiceAccountKey } | null> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("google_drive_sa_json_encrypted")
    .eq("id", workspaceId)
    .single();
  if (!ws?.google_drive_sa_json_encrypted) return null;
  try {
    const credentials = JSON.parse(decrypt(ws.google_drive_sa_json_encrypted)) as ServiceAccountKey;
    if (!credentials.client_email || !credentials.private_key) return null;
    return { credentials };
  } catch {
    return null;
  }
}

async function getAccessToken(creds: ServiceAccountKey): Promise<string | null> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = btoa(
      JSON.stringify({
        iss: creds.client_email,
        scope: DRIVE_SCOPE,
        aud: creds.token_uri || "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    );
    const { createSign } = await import("crypto");
    const sign = createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(creds.private_key, "base64url");
    const jwt = `${header}.${payload}.${signature}`;

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
    });
    if (!res.ok) {
      console.error("[drive] token exchange failed:", await res.text().catch(() => ""));
      return null;
    }
    const data = await res.json();
    return data.access_token || null;
  } catch (err) {
    console.error("[drive] JWT signing failed:", err);
    return null;
  }
}

/** A live Drive session for one box run — token + the two ops we need. */
export class DriveClient {
  private constructor(private token: string) {}

  static async forWorkspace(workspaceId: string): Promise<DriveClient | null> {
    const config = await getDriveConfig(workspaceId);
    if (!config) return null;
    const token = await getAccessToken(config.credentials);
    if (!token) return null;
    return new DriveClient(token);
  }

  /** files.list with a raw Drive `q`. Includes shared-drive results. */
  async list(q: string, pageSize = 200): Promise<DriveFile[]> {
    const params = new URLSearchParams({
      q,
      pageSize: String(pageSize),
      fields: "files(id,name,mimeType,parents)",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
      corpora: "allDrives",
    });
    const res = await fetch(`${DRIVE_BASE}/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      console.error("[drive] list failed:", res.status, await res.text().catch(() => ""));
      return [];
    }
    const data = (await res.json()) as { files?: DriveFile[] };
    return data.files || [];
  }

  /** Folders whose name contains `name` (case-insensitive on Drive's side). */
  async findFolders(name: string): Promise<DriveFile[]> {
    const safe = name.replace(/'/g, "\\'");
    return this.list(`mimeType = 'application/vnd.google-apps.folder' and name contains '${safe}' and trashed = false`);
  }

  /** Image files directly inside a folder. */
  async listImagesInFolder(folderId: string): Promise<DriveFile[]> {
    return this.list(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`);
  }

  /** Subfolders directly inside a folder. */
  async listSubfolders(folderId: string): Promise<DriveFile[]> {
    return this.list(`'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  }

  /** Download a file's bytes (files.get?alt=media). */
  async download(fileId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const res = await fetch(`${DRIVE_BASE}/files/${fileId}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      console.error("[drive] download failed:", res.status);
      return null;
    }
    const mimeType = res.headers.get("content-type") || "image/png";
    return { buffer: Buffer.from(await res.arrayBuffer()), mimeType };
  }
}

// The hero packshot comes ONLY from a product's standardized "Isolated Product
// Shots" subfolder. NEVER from 3D Renders / Pickleball / UGC / Lifestyle — those
// hold box/carton renders and scene shots; sourcing from them once gave a box
// render (e.g. "AswaVANA Orange Passion IFC") as the Guru Focus hero instead of
// the 30-count stand-up bag. See box-product-seeding.md (hero bug fix).
const ISOLATED_FOLDER_KEYWORD = "isolated";
const HERO_EXCLUDED_FOLDER_KEYWORDS = ["3d render", "render", "pickleball", "ugc", "lifestyle", "social"];

/**
 * Resolve candidate isolated packshots for a product/variant, ranked.
 *
 * Handles the documented quirks (box-product-seeding spec):
 *  - the hero source is the product's "Isolated Product Shots" subfolder ONLY
 *    (never 3D Renders / Pickleball / UGC / Lifestyle);
 *  - files are per-variant/flavor — match the variant, prefer front-facing;
 *  - Pods ↔ K-Cups are interchangeable;
 *  - the front-facing BAG/pouch (the multi-serving retail unit) is the primary
 *    hero — stick packs / boxes / cartons / pods are demoted alternates.
 *
 * Returns ranked DriveFile candidates (best first). The caller downloads +
 * vision-confirms the top candidate before using it.
 */
export async function resolveProductShots(
  drive: DriveClient,
  args: { productName: string; variantKeywords?: string[]; preferBag?: boolean },
): Promise<DriveFile[]> {
  const { productName, variantKeywords = [], preferBag = true } = args;

  // 1. Find the product folder (e.g. "Ashwavana Guru Focus", "Amazing Coffee").
  const folders = await drive.findFolders(productName);
  if (folders.length === 0) return [];
  // Prefer the closest name match.
  const target = folders[0];

  // 2. Source the hero packshot ONLY from the "Isolated Product Shots" subfolder.
  //    Fall back to the product-folder root images (never the excluded subfolders)
  //    only if no isolated folder exists yet.
  const subs = await drive.listSubfolders(target.id);
  const isolated = subs.find((s) => s.name.toLowerCase().includes(ISOLATED_FOLDER_KEYWORD));
  const images: DriveFile[] = isolated
    ? await drive.listImagesInFolder(isolated.id)
    : (await drive.listImagesInFolder(target.id)).filter(
        (f) => !HERO_EXCLUDED_FOLDER_KEYWORDS.some((k) => f.name.toLowerCase().includes(k)),
      );
  if (images.length === 0) return [];

  // 3. Rank. Pods ↔ K-Cups interchangeable; front-facing BAG/pouch preferred,
  //    stick-packs / boxes / cartons demoted (never the primary hero).
  const expanded = variantKeywords.flatMap((k) => {
    const kw = k.toLowerCase();
    if (kw.includes("pod")) return [kw, "k-cup", "kcup", "k cup"];
    if (kw.includes("k-cup") || kw.includes("kcup") || kw.includes("k cup")) return [kw, "pod", "pods"];
    return [kw];
  });

  const score = (f: DriveFile): number => {
    const n = f.name.toLowerCase();
    let s = 0;
    if (expanded.some((k) => n.includes(k))) s += 6;
    if (n.includes("front")) s += 4;
    if (preferBag && (n.includes("bag") || n.includes("pouch") || n.includes("stand"))) s += 5;
    if (n.includes("isolated")) s += 2;
    if (/stick/.test(n)) s -= 4; // single-serve alternate, not the hero
    if (/\bbox\b|carton|\bifc\b/.test(n)) s -= 6; // box/carton render, not the retail bag
    return s;
  };

  return [...images].sort((a, b) => score(b) - score(a));
}
