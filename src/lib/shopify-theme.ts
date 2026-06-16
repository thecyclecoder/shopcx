/**
 * Shopify theme management via ShopCX (short-term bridge until the in-house
 * storefront retires Shopify). See docs/brain/specs/shopify-theme-via-shopcx.md.
 *
 * Model (Option A): the theme's **GitHub repo is the source of truth**.
 *   - READ the live theme from Shopify (read_themes) — for reconciliation +
 *     post-deploy verification.
 *   - WRITE changes by committing to the GitHub repo (GITHUB_TOKEN). Shopify's
 *     GitHub integration auto-deploys commits to the connected branch.
 *
 * The live MAIN theme is named "{repo}/{branch}" by Shopify when GitHub-
 * connected (e.g. "theme-superfoodscompany.com/master"), so we can derive the
 * repo + branch from it. Owner isn't in the name → THEME_REPO_OWNER constant.
 *
 * Single-writer rule: while ShopCX/GitHub owns the theme, do NOT edit via the
 * Shopify code editor / customizer or the two diverge. If that happens, run
 * scripts/reconcile-shopify-theme.ts before committing again.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const SHOPIFY_API_VERSION = "2025-07";
const THEME_REPO_OWNER = process.env.SHOPIFY_THEME_REPO_OWNER || "thecyclecoder";
// Fallbacks if the MAIN theme isn't named "{repo}/{branch}".
const THEME_REPO_FALLBACK = process.env.SHOPIFY_THEME_REPO || "theme-superfoodscompany.com";
const THEME_BRANCH_FALLBACK = process.env.SHOPIFY_THEME_BRANCH || "master";

const GITHUB_API = "https://api.github.com";

export interface ThemeFile {
  /** Theme-root-relative path, e.g. "sections/main-product.liquid". */
  path: string;
  /** UTF-8 text content. */
  content: string;
  /** True when the source was binary (content is base64). */
  isBinary: boolean;
}

export interface FileChange {
  path: string;
  /** New UTF-8 content. Omit + set `delete: true` to remove the file. */
  content?: string;
  /** base64 content for binary assets (mutually exclusive with `content`). */
  contentBase64?: string;
  delete?: boolean;
}

export interface ThemeTarget {
  owner: string;
  repo: string;
  branch: string;
}

// ── Shopify side ───────────────────────────────────────────────────

async function shopifyCreds(workspaceId: string): Promise<{ shop: string; token: string }> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select("shopify_access_token_encrypted, shopify_myshopify_domain")
    .eq("id", workspaceId)
    .single();
  if (!data?.shopify_access_token_encrypted || !data?.shopify_myshopify_domain) {
    throw new Error("Shopify not configured for workspace");
  }
  return { shop: data.shopify_myshopify_domain, token: decrypt(data.shopify_access_token_encrypted) };
}

async function shopifyGraphQL<T = Record<string, unknown>>(
  shop: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`Shopify GraphQL: ${res.status} ${JSON.stringify(json.errors || json).slice(0, 300)}`);
  }
  return json.data as T;
}

/** Resolve the published (role MAIN) theme + derive the GitHub repo/branch from its name. */
export async function getLiveTheme(workspaceId: string): Promise<{ id: string; name: string; target: ThemeTarget }> {
  const { shop, token } = await shopifyCreds(workspaceId);
  const data = await shopifyGraphQL<{ themes: { nodes: { id: string; name: string; role: string }[] } }>(
    shop, token, `{ themes(first: 50) { nodes { id name role } } }`,
  );
  const main = data.themes.nodes.find((t) => t.role === "MAIN");
  if (!main) throw new Error("No published (MAIN) theme found");
  // GitHub-connected themes are named "{repo}/{branch}".
  const slash = main.name.indexOf("/");
  const target: ThemeTarget = slash > 0
    ? { owner: THEME_REPO_OWNER, repo: main.name.slice(0, slash), branch: main.name.slice(slash + 1) }
    : { owner: THEME_REPO_OWNER, repo: THEME_REPO_FALLBACK, branch: THEME_BRANCH_FALLBACK };
  return { id: main.id, name: main.name, target };
}

/** Read every file of a theme from Shopify (paginated). Binary files arrive as base64. */
export async function listLiveThemeFiles(workspaceId: string, themeId: string): Promise<ThemeFile[]> {
  const { shop, token } = await shopifyCreds(workspaceId);
  const files: ThemeFile[] = [];
  let cursor: string | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const q = `query($id: ID!, $after: String) {
      theme(id: $id) {
        files(first: 100, after: $after) {
          nodes {
            filename
            body {
              __typename
              ... on OnlineStoreThemeFileBodyText { content }
              ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
              ... on OnlineStoreThemeFileBodyUrl { url }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`;
    const data: {
      theme: { files: { nodes: { filename: string; body: Record<string, string> }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } | null;
    } = await shopifyGraphQL(shop, token, q, { id: themeId, after: cursor });
    const conn = data.theme?.files;
    if (!conn) break;
    for (const n of conn.nodes) {
      const body = n.body;
      if (body.__typename === "OnlineStoreThemeFileBodyText") {
        files.push({ path: n.filename, content: body.content, isBinary: false });
      } else if (body.__typename === "OnlineStoreThemeFileBodyBase64") {
        files.push({ path: n.filename, content: body.contentBase64, isBinary: true });
      } else if (body.__typename === "OnlineStoreThemeFileBodyUrl") {
        // Large file served via URL — fetch and classify by extension.
        const r = await fetch(body.url);
        const buf = Buffer.from(await r.arrayBuffer());
        const isBin = isBinaryPath(n.filename);
        files.push({ path: n.filename, content: isBin ? buf.toString("base64") : buf.toString("utf8"), isBinary: isBin });
      }
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return files;
}

function isBinaryPath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mov|pdf|zip)$/i.test(path);
}

// ── GitHub side (source of truth) ──────────────────────────────────

async function gh<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set");
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${init?.method || "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

/** Read a single file's UTF-8 content from the connected branch (source of truth). */
export async function readThemeFile(target: ThemeTarget, path: string): Promise<string | null> {
  try {
    const data = await gh<{ content: string; encoding: string }>(
      `/repos/${target.owner}/${target.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${target.branch}`,
    );
    return Buffer.from(data.content, data.encoding as BufferEncoding).toString("utf8");
  } catch (e) {
    if (e instanceof Error && e.message.includes(": 404")) return null;
    throw e;
  }
}

/** List every file path in the connected branch's theme tree (recursive). */
export async function listRepoFiles(target: ThemeTarget): Promise<Map<string, string>> {
  const ref = await gh<{ object: { sha: string } }>(`/repos/${target.owner}/${target.repo}/git/ref/heads/${target.branch}`);
  const commit = await gh<{ tree: { sha: string } }>(`/repos/${target.owner}/${target.repo}/git/commits/${ref.object.sha}`);
  const tree = await gh<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(
    `/repos/${target.owner}/${target.repo}/git/trees/${commit.tree.sha}?recursive=1`,
  );
  if (tree.truncated) throw new Error("Repo tree truncated — too many files for a single tree fetch");
  const m = new Map<string, string>();
  for (const t of tree.tree) if (t.type === "blob") m.set(t.path, t.sha);
  return m;
}

/**
 * Commit one or more file changes to the connected branch in a SINGLE atomic
 * commit (Git Data API). Shopify's GitHub integration then auto-deploys it.
 */
export async function commitThemeFiles(
  target: ThemeTarget,
  changes: FileChange[],
  message: string,
): Promise<{ commitSha: string; url: string }> {
  if (!changes.length) throw new Error("no changes to commit");
  const base = `/repos/${target.owner}/${target.repo}`;
  const ref = await gh<{ object: { sha: string } }>(`${base}/git/ref/heads/${target.branch}`);
  const headSha = ref.object.sha;
  const headCommit = await gh<{ tree: { sha: string } }>(`${base}/git/commits/${headSha}`);

  const treeItems: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = [];
  for (const c of changes) {
    if (c.delete) {
      treeItems.push({ path: c.path, mode: "100644", type: "blob", sha: null }); // null sha → delete
      continue;
    }
    const blob = await gh<{ sha: string }>(`${base}/git/blobs`, {
      method: "POST",
      body: JSON.stringify(
        c.contentBase64 != null
          ? { content: c.contentBase64, encoding: "base64" }
          : { content: c.content ?? "", encoding: "utf-8" },
      ),
    });
    treeItems.push({ path: c.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const newTree = await gh<{ sha: string }>(`${base}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: treeItems }),
  });
  const commit = await gh<{ sha: string; html_url: string }>(`${base}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }),
  });
  await gh(`${base}/git/refs/heads/${target.branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });
  return { commitSha: commit.sha, url: commit.html_url };
}

/**
 * Verify the given paths in the live theme match `expected` (UTF-8). Use after
 * a commit to confirm Shopify actually re-pulled the GitHub change.
 */
export async function verifyDeployed(
  workspaceId: string,
  expected: { path: string; content: string }[],
): Promise<{ path: string; ok: boolean }[]> {
  const { id } = await getLiveTheme(workspaceId);
  const live = new Map((await listLiveThemeFiles(workspaceId, id)).map((f) => [f.path, f]));
  return expected.map((e) => {
    const f = live.get(e.path);
    return { path: e.path, ok: !!f && !f.isBinary && f.content === e.content };
  });
}
