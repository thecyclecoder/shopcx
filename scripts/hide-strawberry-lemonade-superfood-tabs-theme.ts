/**
 * Phase 2 of docs/brain/specs/suppress-strawberry-lemonade-superfood-tabs.md —
 * VISUAL suppression of the Strawberry Lemonade variant (42614433480877 /
 * SC-TABS-SL-2) on the live Superfood Tabs storefront product page.
 *
 * Ground truth (founder, 2026-07-11): the current Mixed Berry hide lives in
 * the theme's QUANTITY-BREAKS snippet(s), inside the customize-flavor block,
 * as a Liquid `variant.id ==` comparison — NOT a Dawn `hidden_variants`
 * section setting and NOT a Shopify customizer field. This script finds that
 * comparison and extends it so SL is ALSO excluded, using the exact same
 * mechanism. SL stays ACTIVE in Shopify admin so existing SL subscribers
 * renew unaffected — VISUAL storefront suppression only.
 *
 * Discovery-and-patch:
 *   1. Read the theme repo (source of truth) via listRepoFiles + readThemeFile.
 *   2. Find the Mixed Berry variant id in the products table (auto — the id
 *      isn't hardcoded anywhere in this repo, only its SKU family is).
 *   3. For every SNIPPETS/*.liquid (prioritising quantity-breaks / customize-
 *      flavor names) that references MB, apply `patchLiquidVariantExclusion`
 *      — `variant.id == MB` becomes `variant.id == MB or variant.id == SL`;
 *      `variant.id != MB` becomes `variant.id != MB and variant.id != SL`.
 *   4. As a defensive fallback, also handle any Dawn `hidden_variants` JSON
 *      shape (`patchHiddenVariantsSetting` / `patchJsonForSl`). In the
 *      Superfoods theme neither applies today; the Liquid patch is primary.
 *   5. Commit atomically via commitThemeFiles + poll verifyDeployed.
 *
 * Modes:
 *   --discover   read-only report of every MB reference + planned patch.
 *   (default)    dry-run patch preview (still no commit).
 *   --commit     performs the commit + verifyDeployed poll.
 *
 * FOLLOW-UP (deferred to human per founder): re-order the Superfood Tabs
 * product variants in Shopify admin so Peach Mango is first. Not attempted
 * from the box because it's a Shopify admin action outside the theme repo.
 *
 *   npx tsx scripts/hide-strawberry-lemonade-superfood-tabs-theme.ts --discover
 *   npx tsx scripts/hide-strawberry-lemonade-superfood-tabs-theme.ts
 *   npx tsx scripts/hide-strawberry-lemonade-superfood-tabs-theme.ts --commit
 *
 * Workspace defaults to Superfoods (`WS` env overrides). Requires
 * `GITHUB_TOKEN` (write access to the theme repo) + Shopify creds on the
 * workspace row (same as scripts/reconcile-shopify-theme.ts). See
 * docs/brain/libraries/shopify-theme.md.
 */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";
import {
  patchLiquidVariantExclusion,
  patchJsonForSl,
  patchHiddenVariantsSetting,
} from "../src/lib/shopify-theme-hidden-variants";

const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const DISCOVER = process.argv.includes("--discover");
const COMMIT = process.argv.includes("--commit");

const SL_VARIANT_ID = "42614433480877"; // Strawberry Lemonade — SC-TABS-SL-2
const MB_SKU_CANDIDATES = ["SC-TABS-BERRY", "SC-TABS-MB", "SC-TABS-MB-2"];
const BINARY_RX = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mov|pdf|zip)$/i;

function log(step: string, msg?: string) { console.log(`[hide-sl-theme] [${step}] ${msg ?? ""}`.trimEnd()); }
function warn(step: string, msg: string) { console.warn(`[hide-sl-theme] [${step}] ${msg}`); }
function die(step: string, code: number, msg: string) {
  console.error(`[hide-sl-theme] [${step}] BLOCKED (exit ${code}): ${msg}`);
  process.exit(code);
}

async function findMixedBerryVariantId(workspaceId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data: products, error } = await admin.from("products").select("variants").eq("workspace_id", workspaceId);
  if (error) throw new Error(`products query: ${error.message}`);
  if (!products) return null;
  for (const p of products) {
    const variants = Array.isArray(p.variants) ? p.variants : [];
    for (const v of variants as { id?: unknown; sku?: unknown; title?: unknown; variant_title?: unknown }[]) {
      const sku = String(v.sku ?? "").toUpperCase();
      const title = String(v.title ?? "").toLowerCase();
      const vtitle = String(v.variant_title ?? "").toLowerCase();
      if (MB_SKU_CANDIDATES.includes(sku) || /mixed\s*berry/i.test(title) || /mixed\s*berry/i.test(vtitle)) {
        const id = String(v.id ?? "").trim();
        if (id) return id;
      }
    }
  }
  return null;
}

async function main() {
  log("start", `workspace=${WS} SL=${SL_VARIANT_ID} mode=${COMMIT ? "commit" : DISCOVER ? "discover" : "dry-run"}`);

  log("step", "loading src/lib/shopify-theme");
  const { getLiveTheme, readThemeFile, listRepoFiles, commitThemeFiles, verifyDeployed } = await import(
    "../src/lib/shopify-theme"
  );
  type FileChange = { path: string; content?: string; contentBase64?: string; delete?: boolean };

  let mb: string | null = null;
  try {
    log("step", "resolving Mixed Berry variant id from products table");
    mb = await findMixedBerryVariantId(WS);
    log("mb", mb ?? "(none in products table — the Liquid patch requires an MB anchor)");
  } catch (e) {
    warn("mb", `lookup failed: ${(e as Error).message}`);
  }

  let target: { owner: string; repo: string; branch: string };
  try {
    log("step", "getLiveTheme (Shopify)");
    const live = await getLiveTheme(WS);
    target = live.target;
    log("theme", `${live.name} (${live.id})`);
    log("repo", `${target.owner}/${target.repo}@${target.branch}`);
  } catch (e) {
    die("getLiveTheme", 10, `${(e as Error).message}. Check Shopify creds on workspace ${WS} (shopify_access_token_encrypted / shopify_myshopify_domain).`);
    return;
  }

  let repoFiles: { path: string; content: string }[] = [];
  try {
    log("step", "listRepoFiles + readThemeFile (GitHub)");
    if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN not set on the box — cannot read/write theme repo");
    const tree = await listRepoFiles(target);
    const paths = Array.from(tree.keys()).filter((p) => !BINARY_RX.test(p));
    log("repo-files", `${tree.size} entries; ${paths.length} text file(s) to read`);
    for (const path of paths) {
      const content = await readThemeFile(target, path);
      if (content != null) repoFiles.push({ path, content });
    }
    log("repo-files", `read ${repoFiles.length} content(s)`);
  } catch (e) {
    die("github", 11, `${(e as Error).message}. Check GITHUB_TOKEN (needs write access to ${target.owner}/${target.repo}).`);
    return;
  }

  // Prioritise the CEO-named mechanism: quantity-breaks / customize-flavor
  // snippets bubble up first in both the discovery report and the patch order.
  function priority(path: string): number {
    const lower = path.toLowerCase();
    if (/snippets\/.*quantity.*break/.test(lower)) return 0;
    if (/snippets\/.*customize.*flavor/.test(lower)) return 1;
    if (lower.startsWith("snippets/")) return 2;
    if (/templates\/product/.test(lower)) return 3;
    return 4;
  }
  repoFiles.sort((a, b) => priority(a.path) - priority(b.path));

  interface Occurrence { path: string; isLiquid: boolean; isJson: boolean; content: string; mbLines: number[] }
  const occurrences: Occurrence[] = [];
  const hiddenVariantsSites: { path: string; csv: string }[] = [];

  for (const f of repoFiles) {
    const isLiquid = /\.liquid$/i.test(f.path);
    const isJson = /\.jsonc?$/i.test(f.path) || /^config\/settings_data\.json$/i.test(f.path);
    if (mb && f.content.includes(mb)) {
      const mbLines: number[] = [];
      f.content.split("\n").forEach((line, i) => { if (line.includes(mb!) && !line.includes(SL_VARIANT_ID)) mbLines.push(i + 1); });
      occurrences.push({ path: f.path, isLiquid, isJson, content: f.content, mbLines });
    }
    if (isJson) {
      for (const m of f.content.matchAll(/"hidden_variants"\s*:\s*"([^"]*)"/g)) hiddenVariantsSites.push({ path: f.path, csv: m[1] });
    }
  }

  console.log("");
  console.log(`[hide-sl-theme] === DISCOVERY ===`);
  if (mb) {
    console.log(`Mixed Berry (${mb}) references:`);
    if (!occurrences.length) console.log("  (none — the current MB hiding is NOT stored as the MB variant id anywhere in the theme repo)");
    for (const o of occurrences) {
      console.log(`  · ${o.path}   liquid=${o.isLiquid}   json=${o.isJson}   mb_lines=${o.mbLines.join(",") || "-"}`);
      for (const n of o.mbLines) {
        const line = o.content.split("\n")[n - 1] ?? "";
        console.log(`      line ${n}: ${line.trim()}`);
      }
    }
  }
  console.log(`hidden_variants section settings:`);
  if (!hiddenVariantsSites.length) console.log("  (none — the theme does not carry a Dawn hidden_variants setting)");
  for (const h of hiddenVariantsSites) {
    const already = h.csv.split(",").map((s) => s.trim()).includes(SL_VARIANT_ID);
    console.log(`  · ${h.path}   csv="${h.csv}"   already_has_sl=${already}`);
  }

  if (DISCOVER) {
    log("done", "discover mode — no changes proposed.");
    return;
  }

  const changesByPath = new Map<string, string>();
  if (mb) {
    for (const o of occurrences) {
      if (!o.isLiquid) continue;
      const patched = patchLiquidVariantExclusion(o.content, mb, SL_VARIANT_ID);
      if (patched) changesByPath.set(o.path, patched);
    }
    for (const o of occurrences) {
      if (!o.isJson || changesByPath.has(o.path)) continue;
      const patched = patchJsonForSl(o.content, mb, SL_VARIANT_ID);
      if (patched) changesByPath.set(o.path, patched);
    }
  }
  for (const f of repoFiles) {
    const isJson = /\.jsonc?$/i.test(f.path) || /^config\/settings_data\.json$/i.test(f.path);
    if (!isJson || changesByPath.has(f.path)) continue;
    const hv = patchHiddenVariantsSetting(f.content, SL_VARIANT_ID);
    if (hv) changesByPath.set(f.path, hv);
  }

  if (!changesByPath.size) {
    if (!mb) die("no-mb-id", 7, "Mixed Berry variant id not found in products table — cannot anchor the SL patch.");
    if (!occurrences.length) die("no-mb-in-repo", 8, `Mixed Berry (${mb}) doesn't appear in the theme GitHub repo. Either reconcile first (\`npx tsx scripts/reconcile-shopify-theme.ts --commit\`), or MB was hidden by an inventory rule — introduce a new SL-only exclusion manually in the customize-flavor snippet.`);
    die("liquid-pattern-mismatch", 9, `Mixed Berry (${mb}) appears in Liquid file(s) but NOT as a \`variant.id ==\` / \`!=\` comparison the patcher recognises. Files:\n${occurrences.map((o) => `  · ${o.path} (lines ${o.mbLines.join(", ")})`).join("\n")}\nRun with --discover to see the exact lines and add SL manually next to MB in the same shape.`);
    return;
  }

  console.log("");
  log("plan", `Planned patch(es) (${changesByPath.size} file(s)):`);
  for (const [path, patched] of changesByPath) {
    log("plan", `  · ${path}   (+SL ${SL_VARIANT_ID})`);
    const beforeContent = repoFiles.find((r) => r.path === path)?.content ?? "";
    const beforeLines = beforeContent.split("\n");
    const afterLines = patched.split("\n");
    const max = Math.max(beforeLines.length, afterLines.length);
    for (let i = 0; i < max; i++) {
      if (beforeLines[i] !== afterLines[i]) {
        console.log(`      - ${beforeLines[i] ?? ""}`);
        console.log(`      + ${afterLines[i] ?? ""}`);
      }
    }
  }

  const changes: FileChange[] = Array.from(changesByPath.entries()).map(([path, content]) => ({ path, content }));

  if (!COMMIT) {
    log("done", "DRY RUN — pass --commit to push these changes.");
    return;
  }

  const message = `PDP: hide Strawberry Lemonade variant on Superfood Tabs (crisis availability lever)\n\nExtends the customize-flavor / quantity-breaks Liquid variant.id exclusion so it also excludes ${SL_VARIANT_ID} (SC-TABS-SL-2), using the SAME mechanism already applied to Mixed Berry (${mb}). SL stays ACTIVE in Shopify admin so existing SL subscribers renew unaffected — VISUAL storefront suppression only. See docs/brain/specs/suppress-strawberry-lemonade-superfood-tabs.md.`;
  const commit = await commitThemeFiles(target, changes, message);
  log("commit", `→ ${commit.commitSha}`);
  log("github", commit.url);

  log("verify", "polling verifyDeployed…");
  const expected = changes.map((c) => ({ path: c.path, content: c.content! }));
  for (let attempt = 1; attempt <= 12; attempt++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const rows = await verifyDeployed(WS, expected);
    const allOk = rows.every((r) => r.ok);
    log("verify", `attempt ${attempt}/12 — ${rows.filter((r) => r.ok).length}/${rows.length} files match live`);
    if (allOk) {
      log("done", "LIVE — Strawberry Lemonade is now hidden on the Superfood Tabs PDP. Human follow-up: re-order variants in Shopify admin so Peach Mango is first.");
      return;
    }
  }
  die("verify-timeout", 5, "commit landed but Shopify hasn't re-pulled after ~60s. Check the Shopify → GitHub integration.");
}

main().catch((e) => {
  console.error(`[hide-sl-theme] UNCAUGHT: ${(e as Error).stack || (e as Error).message}`);
  process.exit(1);
});
